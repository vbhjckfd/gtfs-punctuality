# gtfs-punctuality

How late (or early) do Lviv buses really leave the terminus, compared with the **GTFS static timetable**?

Built from the vehicle-position snapshots that [`gtfs-collector`](https://github.com/vbhjckfd/gtfs-collector) archives to Cloudflare R2. Runs entirely on Cloudflare (Workers + D1 + Durable Objects) and fits the free plan.

```
R2  gtfs-lviv/raw/YYYY-MM-DD/*.pb      GTFS-RT snapshots, ~every 10 s   (written by gtfs-collector)
        │  Durable Object alarm, every 30 s: next ≤10 snapshots after a stored cursor
        ▼
Worker: decode → for each vehicle, distance to its trip's first stop → detect departure
        │
        ▼
Durable Object memory: buses waiting at a terminus (pending state machine)
        │  written once, when the departure is confirmed
        ▼
D1  departures   one row per confirmed (trip, planned time, vehicle)
    hist,        1-minute error histograms per day × route and per day × hour
    hist_hour    (the dashboard reads only these)
        ▲
        │  scripts/import-static.mjs   (GitHub Actions, daily; skips unchanged archives)
GTFS static: trips → first stop (lat/lon) + planned departure time
        │
        ▼
GET /api/summary  /api/recent  /api/health   +  static dashboard in public/
```

## What counts as a departure

For every vehicle the Worker measures the distance to the **first stop of the trip it is running**. A departure is recorded only when the vehicle

1. was seen within **50 m** of that stop,
2. left the radius, with the next fix no more than **90 s** after the last one inside,
3. and was seen more than **1 km** away within **10 minutes** of leaving.

The crossing instant is interpolated between the two GPS fixes, so the error is a few seconds, not the 10 s polling step. `delta = actual − planned`; positive is late. The planned time is the trip's first `departure_time`, resolved against the Kyiv service day (trips past `24:00` belong to the previous day).

Step 3 matters. Without it, buses that nudge 300 m along the kerb to a layover spot looked like departures 20 minutes early. Trips never seen standing at the terminus (the feed only starts carrying the `trip_id` once the vehicle is rolling) can't be measured and are skipped, so the numbers describe the measurable subset, and the dashboard shows how many observed terminus stops resolved to a departure.

Summary buckets: **on time** within ±1 min of the plan, **early** earlier than that, **late** later. Bins are whole minutes (rounded), so "±1 min" means under 90 s off. The common −1…+5 min agency window is meant for mid-route stops; at the terminus the departure is fully in the operator's hands, so lateness counts from +2 min. Histograms use one-minute bins clamped to ±60 min.

**Unmatched.** A departure more than 30 min off its plan is reported as *unmatched* and kept out of the medians, percentiles and shares. At that distance a vehicle carrying another trip's `trip_id` is a likelier explanation than a bus leaving half an hour early. On 2026-10-07 the share was ~1% for trams and trolleybuses and ~15% for buses.

**Modes.** Lviv publishes trolleybuses as `route_type = 3` (bus) with a `Тр` prefix, so the mode is derived from both. Results differ sharply by mode. Trams and trolleybuses run at ~85% on time with ~1% unmatched. Buses still leave early about two times in three even after unmatched departures are removed. That is either a real practice or a schedule the buses don't follow, and these data can't tell which.

Ghost entities (a feed that republishes a vehicle whose own timestamp is hours old) are dropped when they trail the feed header by more than 120 s.

## Endpoints

| Path | |
|---|---|
| `/` | dashboard: distribution, by hour, by day, route table (click a route to filter), latest departures |
| `/api/summary?days=7[&route=<route_id>]` | totals, histogram, by day / hour / mode / route (≤ 90 days); every summary carries `unmatched` and `unmatchedShare` |
| `/api/recent?limit=50[&route=<route_id>]` | latest measured departures |
| `/api/health` | `200` when the cursor is < 10 min behind the archive; also restarts the alarm chain if it stopped |

## Setup

Needs Node ≥ 22 and a Cloudflare account that owns (or can read) the collector's R2 bucket.

```sh
npm ci
npx wrangler d1 create punctuality           # put the id in wrangler.toml
npm run db:migrate
npm run static:import                        # schedule → D1 (downloads track.ua-gis.com/gtfs/lviv/static.zip)
npm run deploy
echo "$(openssl rand -hex 24)" | npx wrangler secret put ADMIN_TOKEN
```

The first request to `/api/health` (or `GET /admin/kick` with the token) starts the processing loop. It begins two minutes behind "now" unless a cursor is stored.

`wrangler.toml` binds the bucket `gtfs-lviv`; change `bucket_name` if yours differs.

### Backfill

Replay archived days through the deployed Worker (~30 snapshots per request):

```sh
ADMIN_TOKEN=… node scripts/backfill.mjs https://gtfs-punctuality.<you>.workers.dev 2026-10-07 2026-10-08
```

Departures are matched with the schedule currently in D1, so replay only days covered by the same static feed. Run one backfill at a time and never over the span the live loop is processing: each request replays inside the Processor, and a second backfill would share its replay memory. Mind the daily write budget above.

### Keeping the schedule fresh

`.github/workflows/import-static.yml` re-imports daily and exits early when the archive hash is unchanged. It needs two repository secrets:

1. Create an API token at dash.cloudflare.com → My Profile → API Tokens → *Create Custom Token*, permission **Account · D1 · Edit**, scoped to your account.
2. Store it and the account id:

```sh
gh secret set CLOUDFLARE_API_TOKEN            # paste the token when prompted
gh secret set CLOUDFLARE_ACCOUNT_ID --body <account id from `npx wrangler whoami`>
gh workflow run import-static.yml
```

## Staying inside the D1 free tier

D1 Free allows **100k rows written and 5M rows read per day, per account**. The first version stored every waiting bus in D1 and rewrote its row on each 30-second batch: ~20 writes per departure, 313k writes on the first day, and D1 writes were blocked until midnight UTC. Now:

* a waiting bus lives in the Processor Durable Object's own storage, saved as one blob per batch (one storage row write, whatever the number of buses). Memory alone is not enough: the object is evicted between 30 s alarms, and the version that relied on memory confirmed nothing;
* D1 sees one `INSERT OR IGNORE` per **confirmed** departure (+1 index row) and its two histogram increments, which run only `WHERE changes() = 1`. A replayed batch or a lost context therefore can't count a departure twice, and nothing has to be read back from D1 to check;
* the live cursor and coverage counters are flushed every few minutes, or together with a departure write;
* backfill runs through the same Durable Object queue as the live loop, so the two never race.

Budget: 4 rows written per departure (row, its index entry, two histogram increments). A weekday is ~5k departures, so ~20k rows live; a replayed day costs the same. On 2026-10-09 the live day plus six replayed days crossed the 100k cap: keep backfills to two or three days per UTC day.

When a write fails (say, the daily cap), the loop backs off to one attempt every 5 min and keeps its stored position. Once writes work again it runs batches back to back until it has caught up with the archive. `/admin/state` shows the last error.

`GET /admin/state` (with the token) shows the stored contexts: pending buses, recently confirmed keys and cursor per stream, plus the instance's `bornAt`.

## Why no cron trigger

The Workers Free plan allows five cron triggers per account. A Durable Object alarm (SQLite-backed, free) re-arms itself every `INTERVAL_SEC` instead — the same trick [gtfs-eta](https://github.com/vbhjckfd/gtfs-eta) uses for its feed watchdog. Per run the Worker makes ~25 subrequests (R2 list + gets, D1) against the free-plan limit of 50.

## Limits

* Free plan CPU is 10 ms per invocation; `BATCH_SNAPSHOTS` is kept small for that reason. Raise it on a paid plan to catch up faster.
* `caches.default` is a no-op on `*.workers.dev`; API responses are also memoised per isolate for 60 s. On a custom domain the edge cache takes over.
* `departures` rows are pruned after `KEEP_DEPARTURE_DAYS` (45); the histograms are kept.
* Delay is only measured at the first stop. Mid-route punctuality is a different question (see [gtfs-eta](https://github.com/vbhjckfd/gtfs-eta)).

## Development

```sh
npm test      # detection state machine, protobuf decoder, Kyiv time, stats
npm run dev   # wrangler dev
```

WTFPL.
