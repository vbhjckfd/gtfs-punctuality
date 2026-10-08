import { describe, it, expect } from "vitest";
import { processBatch, newContext } from "../src/process.js";

// --- tiny GTFS-RT encoder (same as pb.test.js) ---
const varint = (n) => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const tag = (f, w) => varint((f << 3) | w);
const ld = (f, bytes) => [...tag(f, 2), ...varint(bytes.length), ...bytes];
const s = (f, str) => ld(f, [...new TextEncoder().encode(str)]);
const f32 = (f, x) => [...tag(f, 5), ...new Uint8Array(new Float32Array([x]).buffer)];
const feed = (ts, lat) => new Uint8Array([
  ...ld(1, [...s(1, "2.0"), ...tag(3, 0), ...varint(ts)]),
  ...ld(2, [...s(1, "e"), ...ld(4, [...ld(1, s(1, "T1")), ...ld(2, [...f32(1, lat), ...f32(2, 24)]), ...tag(5, 0), ...varint(ts), ...ld(8, s(1, "V1"))])]),
]);

const STOP_LAT = 49.8;
const PLANNED = Date.UTC(2026, 6, 1, 5, 0) / 1000; // 08:00 Kyiv
const DEP_SEC = 8 * 3600;

// Bus stands at the stop for 5 min, leaves at +2 min late, is 1.3 km away 70 s later.
function snapshots() {
  const out = [];
  for (let t = PLANNED - 180; t <= PLANNED + 120; t += 10) out.push([t, STOP_LAT]);
  out.push([PLANNED + 130, STOP_LAT + 0.001], [PLANNED + 140, STOP_LAT + 0.004], [PLANNED + 190, STOP_LAT + 0.012]);
  return out.map(([t, lat]) => ({ key: `raw/2026-07-01/${new Date(t * 1000).toISOString()}.pb`, body: feed(t, lat) }));
}

function fakeEnv(objects) {
  const writes = [];
  const departures = [];
  const R2 = {
    async list({ startAfter, limit }) {
      return { objects: objects.filter((o) => o.key > startAfter).slice(0, limit).map((o) => ({ key: o.key })) };
    },
    async get(key) {
      const o = objects.find((x) => x.key === key);
      return o && { arrayBuffer: async () => o.body.buffer };
    },
  };
  const stmt = (sql) => ({
    sql, args: [],
    bind(...a) { this.args = a; return this; },
    async all() {
      if (sql.includes("FROM trips")) return { results: [{ trip_id: "T1", route_id: "R1", first_lat: STOP_LAT, first_lon: 24, first_dep_sec: DEP_SEC }] };
      if (sql.includes("FROM departures")) return { results: departures.map((d) => ({ trip_id: d[0], planned_ts: d[1], vehicle_id: d[2] })) };
      return { results: [] };
    },
    async first() { return null; },
  });
  const DB = {
    prepare: stmt,
    async batch(stmts) {
      for (const st of stmts) {
        writes.push(st.sql.split("(")[0].trim());
        if (st.sql.startsWith("INSERT OR IGNORE INTO departures")) departures.push(st.args);
      }
    },
  };
  return { env: { DB, RAW: R2 }, writes, departures };
}

describe("processBatch", () => {
  it("writes a departure once, after it is confirmed, across batches", async () => {
    const objs = snapshots();
    const { env, writes, departures } = fakeEnv(objs);
    const cx = newContext();
    let after = "raw/2026-07-01/";
    for (;;) {
      const st = await processBatch(env, cx, { limit: 7, startAfter: after });
      if (!st.snapshots) break;
      after = st.cursor;
    }
    expect(departures).toHaveLength(1);
    const [, planned, vehicle, route, , , , , , , actual, delta] = departures[0];
    expect([planned, vehicle, route]).toEqual([PLANNED, "V1", "R1"]);
    expect(delta).toBeGreaterThanOrEqual(120);
    expect(delta).toBeLessThanOrEqual(130);
    expect(actual - planned).toBe(delta);
    expect(writes.filter((w) => w.startsWith("INSERT OR IGNORE INTO departures"))).toHaveLength(1);
    expect(writes.filter((w) => w === "INSERT INTO hist")).toHaveLength(1);
    expect(cx.pending.size).toBe(0);
  });

  it("does not count a departure again when the same snapshots are replayed", async () => {
    const objs = snapshots();
    const { env, departures } = fakeEnv(objs);
    for (let round = 0; round < 2; round++) {
      const cx = newContext(); // fresh memory, as after an eviction
      let after = "raw/2026-07-01/";
      for (;;) {
        const st = await processBatch(env, cx, { limit: 40, startAfter: after });
        if (!st.snapshots) break;
        after = st.cursor;
      }
    }
    expect(departures).toHaveLength(1);
  });
});
