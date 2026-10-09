import { decodeFeed } from "./pb.js";
import { haversine } from "./geo.js";
import { plannedTs, kyivDay, kyivHour } from "./time.js";
import { step, MAX_STALE, IN_RADIUS } from "./detect.js";

const CHUNK_IN = 80;          // ids per IN (...) — D1 allows 100 bound parameters
const MAX_TRIP_CACHE = 60000;
const TRIP_CACHE_TTL = 10 * 60_000; // a re-imported schedule is picked up within this
const tripCache = new Map();  // trip_id -> trip row | null, survives across invocations of one isolate
let tripCacheBorn = Date.now();

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const marks = (n) => Array(n).fill("?").join(",");

async function loadTrips(db, ids) {
  if (Date.now() - tripCacheBorn > TRIP_CACHE_TTL || tripCache.size + ids.length > MAX_TRIP_CACHE) {
    tripCache.clear();
    tripCacheBorn = Date.now();
  }
  const missing = ids.filter((id) => !tripCache.has(id));
  const rows = await Promise.all(chunks(missing, CHUNK_IN).map((c) =>
    db.prepare(`SELECT trip_id, route_id, first_lat, first_lon, first_dep_sec FROM trips WHERE trip_id IN (${marks(c.length)})`).bind(...c).all()));
  for (const id of missing) tripCache.set(id, null);
  for (const r of rows) for (const t of r.results) tripCache.set(t.trip_id, t);
}

// D1 on the free plan allows 100k rows written and 5M rows read per day. A
// departure is written once, when it is confirmed; the in-between state of a
// bus waiting at the terminus lives in a context object that the Processor
// Durable Object keeps in its own storage (one blob per batch: Durable Objects
// are evicted between alarms, so memory alone does not survive).
//
// D1 writes are idempotent on their own: a departure row is INSERT OR IGNORE,
// and its histogram increments run only if that insert added a row, so a
// replayed batch or a lost context can never count a departure twice.

const PENDING_MAX_AGE = 2 * 3600;   // s: drop a pending state not updated for this long
const DONE_KEEP = 3 * 3600;         // s: remember confirmed keys this long (loop routes come back to their first stop)
const COVER_FLUSH_MS = 10 * 60_000;
const CURSOR_FLUSH_MS = 5 * 60_000;

/** Per-stream state: one for the live loop, one for replays. */
export function newContext() {
  return { pending: new Map(), done: new Map(), cover: new Map(), coverFlushedAt: Date.now(), cursor: null, cursorWrittenAt: 0 };
}

/** Plain-object form for Durable Object storage. */
export function dumpContext(cx) {
  return { v: 1, pending: [...cx.pending.values()], done: [...cx.done], cover: [...cx.cover], coverFlushedAt: cx.coverFlushedAt, cursor: cx.cursor, cursorWrittenAt: cx.cursorWrittenAt };
}

export function loadContext(o) {
  if (!o || o.v !== 1) return newContext();
  const pending = new Map(o.pending.map((p) => [`${p.trip_id}|${p.planned_ts}|${p.vehicle_id}`, p]));
  return { pending, done: new Map(o.done), cover: new Map(o.cover), coverFlushedAt: o.coverFlushedAt, cursor: o.cursor, cursorWrittenAt: o.cursorWrittenAt };
}

const INSERT = `INSERT OR IGNORE INTO departures (trip_id, planned_ts, vehicle_id, route_id, first_seen, last_in_ts, last_in_d, last_ts, cross_ts, cross_obs_ts, actual_ts, delta_s)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
// changes() is the row count of the statement just before, so each increment
// runs only if the departure row above it was new (and the hour one only if the
// route one ran). Keep the three statements adjacent and in this order.
const HIST = `INSERT INTO hist (day, route_id, bin, n) SELECT ?, ?, ?, 1 WHERE changes() = 1
  ON CONFLICT (day, route_id, bin) DO UPDATE SET n = n + 1`;
const HIST_HOUR = `INSERT INTO hist_hour (day, hour, bin, n) SELECT ?, ?, ?, 1 WHERE changes() = 1
  ON CONFLICT (day, hour, bin) DO UPDATE SET n = n + 1`;
const COVER = `INSERT INTO coverage (day, seen, confirmed) VALUES (?,?,?) ON CONFLICT (day) DO UPDATE SET seen = seen + excluded.seen, confirmed = confirmed + excluded.confirmed`;
const CURSOR = "INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v";

const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/**
 * Consume the next batch of archived snapshots.
 * Live (no startAfter): continues from the context's cursor, persisted to D1 now and then.
 * Replay (startAfter): reads from there and never touches the live cursor.
 * Must not run concurrently for one context: the Processor serialises calls.
 * On error, discard the context and reload the last stored one (D1 writes are idempotent).
 * @returns {{snapshots:number, observations:number, opened:number, confirmed:number, pending:number, cursor:string|null, caughtUp:boolean}}
 */
export async function processBatch(env, cx, { limit = 12, startAfter } = {}) {
  const db = env.DB;
  const live = startAfter === undefined;
  let cursor = live ? cx.cursor ?? (await db.prepare("SELECT v FROM meta WHERE k='cursor'").first("v")) : startAfter;
  if (!cursor) {
    const iso = new Date(Date.now() - 120_000).toISOString();
    cursor = `raw/${iso.slice(0, 10)}/${iso}`;
  }
  const listed = await env.RAW.list({ prefix: "raw/", startAfter: cursor, limit });
  const keys = listed.objects.map((o) => o.key);
  const stat = { snapshots: keys.length, observations: 0, opened: 0, confirmed: 0, pending: cx.pending.size, cursor, caughtUp: keys.length < limit };
  if (!keys.length) return stat;

  const feeds = await Promise.all(keys.map(async (k) => {
    const o = await env.RAW.get(k);
    return o ? decodeFeed(await o.arrayBuffer()) : { timestamp: 0, vehicles: [] };
  }));
  const stamps = feeds.map((f) => f.timestamp).filter(Boolean);
  const maxTs = stamps.length ? Math.max(...stamps) : 0;

  await loadTrips(db, [...new Set(feeds.flatMap((f) => f.vehicles.map((v) => v.tripId)))]);

  // (trip, vehicle) pairs with a pending state; a fix far from the first stop only matters for those.
  const open = new Set();
  for (const s of cx.pending.values()) open.add(`${s.trip_id}|${s.vehicle_id}`);

  const confirmed = [];
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
      if (cx.done.has(key)) continue;
      const prev = cx.pending.get(key) ?? null;
      const next = step(prev, { ts: v.timestamp, d }, planned);
      if (!next || next === prev) continue;
      const day = kyivDay(planned).day;
      if (!prev) {
        Object.assign(next, { trip_id: v.tripId, vehicle_id: v.vehicleId, planned_ts: planned, route_id: trip.route_id });
        open.add(`${v.tripId}|${v.vehicleId}`);
        bump(cx.cover, `${day}|seen`);
        stat.opened++;
      }
      if (next.actual_ts != null) {
        cx.pending.delete(key);
        cx.done.set(key, next.actual_ts);
        bump(cx.cover, `${day}|confirmed`);
        confirmed.push({ ...next, day, hour: kyivHour(planned) });
      } else {
        cx.pending.set(key, next);
      }
    }
  }
  for (const [k, s] of cx.pending) if (s.last_ts < maxTs - PENDING_MAX_AGE) cx.pending.delete(k);
  for (const [k, ts] of cx.done) if (ts < maxTs - DONE_KEEP) cx.done.delete(k);
  stat.confirmed = confirmed.length;
  stat.pending = cx.pending.size;

  // Writes: each confirmed departure once, with its histogram increments.
  const stmts = [];
  for (const s of confirmed) {
    const bin = Math.max(-60, Math.min(60, Math.round(s.delta_s / 60)));
    stmts.push(
      db.prepare(INSERT).bind(s.trip_id, s.planned_ts, s.vehicle_id, s.route_id, s.first_seen, s.last_in_ts, s.last_in_d, s.last_ts, s.cross_ts, s.cross_obs_ts, s.actual_ts, s.delta_s),
      db.prepare(HIST).bind(s.day, s.route_id, bin),
      db.prepare(HIST_HOUR).bind(s.day, s.hour, bin),
    );
  }

  if (cx.cover.size && Date.now() - cx.coverFlushedAt > COVER_FLUSH_MS) {
    const days = new Set([...cx.cover.keys()].map((k) => k.split("|")[0]));
    for (const day of days) stmts.push(db.prepare(COVER).bind(day, cx.cover.get(`${day}|seen`) ?? 0, cx.cover.get(`${day}|confirmed`) ?? 0));
    cx.cover.clear();
    cx.coverFlushedAt = Date.now();
  }

  const last = keys[keys.length - 1];
  if (live) {
    cx.cursor = last;
    // Persist the cursor with any other write (so a departure and the position
    // after it commit together), otherwise at most every few minutes.
    if (stmts.length || Date.now() - cx.cursorWrittenAt > CURSOR_FLUSH_MS) {
      stmts.push(db.prepare(CURSOR).bind(last));
      cx.cursorWrittenAt = Date.now();
    }
  }
  // One batch = one transaction. If it throws, the caller must discard this
  // context (memory already counts these departures as done) and start over
  // from the persisted cursor.
  if (stmts.length) await db.batch(stmts);
  stat.cursor = last;
  return stat;
}
