import { decodeFeed } from "./pb.js";
import { haversine } from "./geo.js";
import { plannedTs, kyivDay, kyivHour } from "./time.js";
import { step, MAX_STALE, IN_RADIUS } from "./detect.js";

const CHUNK_IN = 80;          // ids per IN (...) — D1 allows 100 bound parameters
const MAX_TRIP_CACHE = 60000;
const tripCache = new Map();  // trip_id -> trip row | null, survives across invocations of one isolate

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const marks = (n) => Array(n).fill("?").join(",");

async function loadTrips(db, ids) {
  const missing = ids.filter((id) => !tripCache.has(id));
  if (tripCache.size + missing.length > MAX_TRIP_CACHE) tripCache.clear();
  const rows = await Promise.all(chunks(missing, CHUNK_IN).map((c) =>
    db.prepare(`SELECT trip_id, route_id, first_lat, first_lon, first_dep_sec FROM trips WHERE trip_id IN (${marks(c.length)})`).bind(...c).all()));
  for (const id of missing) tripCache.set(id, null);
  for (const r of rows) for (const t of r.results) tripCache.set(t.trip_id, t);
}

async function loadStates(db, ids, since) {
  const out = new Map();
  const rows = await Promise.all(chunks(ids, CHUNK_IN - 1).map((c) =>
    db.prepare(`SELECT * FROM departures WHERE planned_ts > ? AND trip_id IN (${marks(c.length)})`).bind(since, ...c).all()));
  for (const r of rows) for (const s of r.results) out.set(`${s.trip_id}|${s.planned_ts}|${s.vehicle_id}`, s);
  return out;
}

const UPSERT = `INSERT INTO departures (trip_id, planned_ts, vehicle_id, route_id, first_seen, last_in_ts, last_in_d, last_ts, cross_ts, cross_obs_ts, actual_ts, delta_s)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (trip_id, planned_ts, vehicle_id) DO UPDATE SET
    last_in_ts=excluded.last_in_ts, last_in_d=excluded.last_in_d, last_ts=excluded.last_ts,
    cross_ts=excluded.cross_ts, cross_obs_ts=excluded.cross_obs_ts, actual_ts=excluded.actual_ts, delta_s=excluded.delta_s`;
const HIST = `INSERT INTO hist (day, route_id, bin, n) VALUES (?,?,?,1) ON CONFLICT (day, route_id, bin) DO UPDATE SET n = n + 1`;
const HIST_HOUR = `INSERT INTO hist_hour (day, hour, bin, n) VALUES (?,?,?,1) ON CONFLICT (day, hour, bin) DO UPDATE SET n = n + 1`;
const COVER = `INSERT INTO coverage (day, seen, confirmed) VALUES (?,?,?) ON CONFLICT (day) DO UPDATE SET seen = seen + excluded.seen, confirmed = confirmed + excluded.confirmed`;

/**
 * Consume the next batch of archived snapshots after the stored cursor.
 * @returns {{snapshots:number, observations:number, opened:number, confirmed:number, cursor:string|null, caughtUp:boolean}}
 */
export async function processBatch(env, { limit = 12, startAfter } = {}) {
  const db = env.DB;
  let cursor = startAfter ?? (await db.prepare("SELECT v FROM meta WHERE k='cursor'").first("v"));
  if (!cursor) {
    const iso = new Date(Date.now() - 120_000).toISOString();
    cursor = `raw/${iso.slice(0, 10)}/${iso}`;
  }
  const listed = await env.RAW.list({ prefix: "raw/", startAfter: cursor, limit });
  const keys = listed.objects.map((o) => o.key);
  const stat = { snapshots: keys.length, observations: 0, opened: 0, confirmed: 0, cursor, caughtUp: keys.length < limit };
  if (!keys.length) return stat;

  const feeds = await Promise.all(keys.map(async (k) => {
    const o = await env.RAW.get(k);
    return o ? decodeFeed(await o.arrayBuffer()) : { timestamp: 0, vehicles: [] };
  }));

  const tripIds = [...new Set(feeds.flatMap((f) => f.vehicles.map((v) => v.tripId)))];
  await loadTrips(db, tripIds);
  const known = tripIds.filter((id) => tripCache.get(id));
  const lastTs = Math.max(...feeds.map((f) => f.timestamp));
  const states = await loadStates(db, known, lastTs - 3 * 86400);

  // (trip, vehicle) pairs with an open row; a fix far from the first stop only matters for those.
  const open = new Set();
  for (const s of states.values()) if (s.actual_ts == null) open.add(`${s.trip_id}|${s.vehicle_id}`);

  const dirty = new Map(); // key -> { trip, state, fresh }
  for (const feed of feeds) {
    for (const v of feed.vehicles) {
      const trip = tripCache.get(v.tripId);
      if (!trip || !v.timestamp || feed.timestamp - v.timestamp > MAX_STALE) continue;
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
      stat.observations++;
      const d = haversine(trip.first_lat, trip.first_lon, v.lat, v.lon);
      if (d > IN_RADIUS && !open.has(`${v.tripId}|${v.vehicleId}`)) continue;
      const planned = plannedTs(v.timestamp, trip.first_dep_sec);
      const key = `${v.tripId}|${planned}|${v.vehicleId}`;
      const prev = states.get(key) ?? null;
      const next = step(prev, { ts: v.timestamp, d }, planned);
      if (!next || next === prev) continue;
      states.set(key, next);
      open.add(`${v.tripId}|${v.vehicleId}`);
      const e = dirty.get(key);
      dirty.set(key, { trip, planned, vehicleId: v.vehicleId, state: next, fresh: e ? e.fresh : !prev });
    }
  }

  // One group of statements per departure so a row and its aggregates always
  // land in the same transaction.
  const groups = [];
  const cover = new Map();
  for (const { trip, planned, vehicleId, state: s, fresh } of dirty.values()) {
    const g = [db.prepare(UPSERT).bind(trip.trip_id, planned, vehicleId, trip.route_id, s.first_seen, s.last_in_ts, s.last_in_d, s.last_ts, s.cross_ts, s.cross_obs_ts, s.actual_ts, s.delta_s)];
    const day = kyivDay(planned).day;
    const c = cover.get(day) ?? { seen: 0, confirmed: 0 };
    if (fresh) { c.seen++; stat.opened++; }
    if (s.actual_ts != null) {
      c.confirmed++; stat.confirmed++;
      const bin = Math.max(-60, Math.min(60, Math.round(s.delta_s / 60)));
      g.push(db.prepare(HIST).bind(day, trip.route_id, bin), db.prepare(HIST_HOUR).bind(day, kyivHour(planned), bin));
    }
    cover.set(day, c);
    groups.push(g);
  }
  for (const [day, c] of cover) if (c.seen || c.confirmed) groups.push([db.prepare(COVER).bind(day, c.seen, c.confirmed)]);

  const cursorStmt = db.prepare("INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(keys[keys.length - 1]);
  const batches = [[]];
  for (const g of groups) {
    if (batches[batches.length - 1].length + g.length > 90) batches.push([]);
    batches[batches.length - 1].push(...g);
  }
  // An explicit startAfter is a replay (backfill): leave the live cursor alone.
  if (startAfter === undefined) batches[batches.length - 1].push(cursorStmt);
  for (const b of batches) if (b.length) await db.batch(b);
  stat.cursor = keys[keys.length - 1];
  return stat;
}
