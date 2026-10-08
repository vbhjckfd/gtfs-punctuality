#!/usr/bin/env node
// Replay archived snapshots through the deployed Worker, ~20 per request.
//
//   ADMIN_TOKEN=… node scripts/backfill.mjs https://gtfs-punctuality.<you>.workers.dev 2026-10-07 [2026-10-08]
//
// Departures are matched against the schedule currently in D1, so only replay
// days that fall under the same static feed.
const [base, from, to = from] = process.argv.slice(2);
const token = process.env.ADMIN_TOKEN;
if (!base || !from || !token) {
  console.error("usage: ADMIN_TOKEN=… backfill.mjs <worker-url> <from YYYY-MM-DD> [to YYYY-MM-DD]");
  process.exit(1);
}
const headers = { authorization: `Bearer ${token}` };
let after = `raw/${from}/`;
const stop = `raw/${to}/~`;
let total = 0, confirmed = 0, limit = 12, fails = 0;
const maxLimit = 30;
for (;;) {
  const res = await fetch(`${base}/admin/run?limit=${limit}&after=${encodeURIComponent(after)}`, { headers });
  if (!res.ok) {
    // CPU limit (1102) or a D1 hiccup: retry smaller, then creep back up
    if (++fails > 8) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    limit = Math.max(2, Math.floor(limit / 2));
    continue;
  }
  fails = 0;
  limit = Math.min(maxLimit, limit + 1);
  const s = await res.json();
  if (!s.snapshots || s.cursor >= stop) break;
  after = s.cursor;
  total += s.snapshots; confirmed += s.confirmed;
  if (total % 300 < 30) console.log(`${after}  snapshots=${total} confirmed=${confirmed}`);
}
console.log(`done: ${total} snapshots, ${confirmed} departures confirmed`);
