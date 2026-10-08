import { summarize, summarizeBy } from "./stats.js";
import { kyivDay } from "./time.js";

const json = (body, maxAge = 300) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*" },
});
const bad = (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json" } });

function fromDay(days) {
  const today = kyivDay(Math.floor(Date.now() / 1000)).midnight;
  return kyivDay(today - (days - 1) * 86400 + 3600).day;
}

async function summary(db, url) {
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days") ?? "7", 10) || 7));
  const route = url.searchParams.get("route");
  const from = fromDay(days);
  const rf = route ? " AND route_id = ?" : "";
  const args = route ? [from, route] : [from];

  const [byDayBin, hourBin, routeBin, cov] = await Promise.all([
    db.prepare(`SELECT day, bin, SUM(n) n FROM hist WHERE day >= ?${rf} GROUP BY day, bin`).bind(...args).all(),
    route ? null : db.prepare("SELECT hour, bin, SUM(n) n FROM hist_hour WHERE day >= ? GROUP BY hour, bin").bind(from).all(),
    route ? null : db.prepare("SELECT h.route_id, r.short_name, h.bin, SUM(h.n) n FROM hist h JOIN routes r USING (route_id) WHERE h.day >= ? GROUP BY h.route_id, h.bin").bind(from).all(),
    db.prepare("SELECT SUM(seen) seen, SUM(confirmed) confirmed FROM coverage WHERE day >= ?").bind(from).first(),
  ]);

  const dayRows = byDayBin.results;
  const histMap = new Map();
  for (const r of dayRows) histMap.set(r.bin, (histMap.get(r.bin) ?? 0) + r.n);
  const out = {
    from, days, route,
    total: summarize(dayRows),
    histogram: [...histMap.entries()].sort((a, b) => a[0] - b[0]).map(([bin, n]) => ({ bin, n })),
    byDay: summarizeBy(dayRows, "day").sort((a, b) => a.day.localeCompare(b.day)),
    coverage: { opened: cov?.seen ?? 0, confirmed: cov?.confirmed ?? 0 },
  };
  if (hourBin) out.byHour = summarizeBy(hourBin.results, "hour").sort((a, b) => a.hour - b.hour);
  if (routeBin) {
    out.routes = summarizeBy(routeBin.results, "route_id", (id) => ({ shortName: routeBin.results.find((r) => r.route_id === id).short_name }))
      .sort((a, b) => b.n - a.n);
  }
  return json(out);
}

async function recent(db, url) {
  const route = url.searchParams.get("route");
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const sql = `SELECT d.trip_id, d.vehicle_id, d.route_id, r.short_name, t.headsign, d.planned_ts, d.actual_ts, d.delta_s
    FROM departures d JOIN routes r USING (route_id) JOIN trips t USING (trip_id)
    WHERE d.actual_ts IS NOT NULL ${route ? "AND d.route_id = ?" : ""} ORDER BY d.actual_ts DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...(route ? [route, limit] : [limit])).all();
  return json({ departures: results }, 60);
}

async function health(db) {
  const [m, c, t, last] = await Promise.all([
    db.prepare("SELECT k, v FROM meta").all(),
    db.prepare("SELECT COUNT(*) n FROM trips").first(),
    db.prepare("SELECT COUNT(*) n FROM routes").first(),
    db.prepare("SELECT MAX(actual_ts) ts FROM departures").first(),
  ]);
  const meta = Object.fromEntries(m.results.map((r) => [r.k, r.v]));
  const cursorMatch = meta.cursor?.match(/\/(\d{4}-\d\d-\d\dT[\d:.]+Z)\.pb$/);
  const cursorTs = cursorMatch ? Date.parse(cursorMatch[1]) / 1000 : null;
  const lagSec = cursorTs ? Math.round(Date.now() / 1000 - cursorTs) : null;
  const body = { ok: lagSec != null && lagSec < 600 && c.n > 0, cursor: meta.cursor ?? null, lagSec, trips: c.n, routes: t.n, staticSha: meta.static_sha ?? null, staticImportedAt: meta.static_imported_at ?? null, lastDepartureTs: last?.ts ?? null };
  return new Response(JSON.stringify(body), { status: body.ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== "GET") return bad("method not allowed", 405);
  if (url.pathname === "/api/health") return health(env.DB);

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  let res;
  if (url.pathname === "/api/summary") res = await summary(env.DB, url);
  else if (url.pathname === "/api/recent") res = await recent(env.DB, url);
  else return bad("not found", 404);
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}
