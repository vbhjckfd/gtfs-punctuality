# gtfs-punctuality

🇬🇧 **English** · 🇺🇦 [Українська](README.uk.md)

How late (or early) do Lviv buses really leave the terminus, compared with the **GTFS static timetable**?

Live dashboard: **https://punctuality.lad.lviv.ua/**

Built from the vehicle-position snapshots that [`gtfs-collector`](https://github.com/vbhjckfd/gtfs-collector) archives to Cloudflare R2. Runs entirely on Cloudflare (Workers + D1 + Durable Objects) and fits the free plan. The dashboard is in English and Ukrainian; the flags in the top corner switch between them, and the choice is remembered in the browser.

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

## For data analysts

This section is the methodology: what is measured, how the figures are computed, and where they can mislead. All thresholds live in [`src/detect.js`](src/detect.js) and [`src/stats.js`](src/stats.js); `/api/summary` returns the ones in use under `thresholds`.

### What is measured

* **Unit of observation:** one confirmed departure from a trip's **first stop**, keyed by (`trip_id`, planned departure instant, `vehicle_id`).
* **Measure:** `delta = actual − planned`, in seconds. Positive is late, negative is early.
* **Scope:** the terminus only. Mid-route punctuality is a different question (see [gtfs-eta](https://github.com/vbhjckfd/gtfs-eta)).

### Data sources

| | Source | Refresh |
|---|---|---|
| Actual | GTFS-RT VehiclePositions for Lviv, archived by `gtfs-collector` to R2 | a snapshot about every 10 s, processed a few minutes behind real time |
| Planned | GTFS static (`track.ua-gis.com/gtfs/lviv/static.zip`) | GitHub Actions, daily; skipped when the archive is unchanged |

From GTFS static only the first stop of each trip is kept: the stop with the lowest `stop_sequence`, its coordinates and its `departure_time` (or `arrival_time` when that is empty). The trip is identified by the `trip_id` the vehicle itself reports in the feed. The service calendar is not consulted: a vehicle reporting a trip is taken as proof the trip runs that day. GTFS times can run past `24:00`, so the planned instant is taken on whichever Kyiv service day (yesterday, today or tomorrow) puts it closest to the observation.

### What counts as a departure

For every vehicle the Worker measures the distance to the first stop of the trip it is running. A departure is recorded only when the vehicle

1. was seen within **50 m** of that stop,
2. left the radius, with the next fix no more than **90 s** after the last one inside,
3. and was seen more than **1 km** away within **10 minutes** of leaving.

The departure instant is when the vehicle crosses the 50 m circle, linearly interpolated between the last fix inside and the first fix outside. The error is a few seconds, not the 10 s polling step.

Step 3 matters. Without it, buses that nudge 300 m along the kerb to a layover spot looked like departures 20 minutes early.

Feed entities whose own timestamp trails the feed header by more than 120 s are dropped (a "ghost" vehicle republished hours after it was last seen).

### Bins and categories

Every departure is put into a one-minute bin: `bin = round(delta / 60 s)` (JavaScript `Math.round`, so halves round up), clamped to −60…+60. The aggregate tables store only bin counts, so every published figure has whole-minute resolution.

| Category | Bins | In seconds |
|---|---|---|
| early | ≤ −2 | `delta < −90 s` |
| on time | −1 … +1 | `−90 s ≤ delta < +90 s` |
| late | ≥ +2 | `delta ≥ +90 s` |
| unmatched | \|bin\| > 30 | more than ~30 min off the plan |

The common −1…+5 min agency window is meant for mid-route stops. At the terminus the departure is fully in the operator's hands, so lateness counts from +2 min.

**Unmatched.** A departure more than 30 min off its plan is reported as *unmatched* and kept out of every other figure (count, shares, median, percentiles, mean). At that distance a vehicle carrying another trip's `trip_id` is a likelier explanation than a bus leaving half an hour early. It is reported separately as `unmatched` (count) and `unmatchedShare = unmatched / (n + unmatched)`. On 2026-10-07 the share was ~1% for trams and trolleybuses and ~15% for buses.

### Statistics

All figures are computed from the binned distribution of **matched** departures (`n`):

* `early`, `onTime`, `late`: shares of `n`; `onTime = 1 − early − late`.
* `medianMin`, `p10Min`, `p90Min`: nearest-rank percentiles, the lowest bin whose cumulative count reaches `q · n`. Whole minutes.
* `meanMin`: mean of the bins (in the API, not on the dashboard).
* Grouping is **pooled**: every departure has equal weight, so a route with many trips weighs more in the totals than a route with few. Route-level figures are in the route table and in `routes[]`; average them yourself if you want every route to count equally.
* **Day** is the Kyiv calendar date of the *planned* departure, **hour** is the Kyiv hour of the planned departure. The "N days" window is today plus the N − 1 previous Kyiv days, so today is always partial.
* On the hour and day charts, bars with fewer than 20 departures are faded: treat them as noise.

### Coverage and bias

* **Coverage** (`coverage.confirmed / coverage.opened`) is the share of observed terminus stops that resolved to a confirmed departure. `opened` counts a vehicle seen within 50 m of its trip's first stop; `confirmed` counts those that then passed steps 2–3.
* **Not observed at all:** trips never seen standing at the terminus with their `trip_id` (the feed often starts carrying the `trip_id` only once the vehicle is rolling) and cancelled trips. They are in neither the numerator nor the denominator. The figures therefore describe the **measurable subset** of departures, not every scheduled trip. Do not use them to estimate the share of trips run. If missingness correlates with lateness (say, a bus that arrives late, turns round at once and only then switches its `trip_id`), the results are biased.
* **Position of the stop:** the departure is measured against the GTFS stop coordinates. When the real stand is further than ~50 m from those coordinates, the trip is never "at the stop" and is not measured.
* **Two vehicles reporting the same trip** each produce a row; the primary key includes `vehicle_id`.
* **Schedule version:** live departures are matched with the static feed current at processing time. Backfills of old days use the static feed in D1 at replay time, which may differ from the one that was valid then.

### Modes

Lviv publishes trolleybuses as `route_type = 3` (bus) with a `Тр` prefix, so the mode is derived from both: `route_type 0` = tram, `route_type 11` or a `Тр` prefix = trolleybus, everything else = bus. Results differ sharply by mode. Trams and trolleybuses run at ~85% on time with ~1% unmatched. Buses still leave early about two times in three even after unmatched departures are removed. That is either a real practice or a schedule the buses don't follow, and these data can't tell which.

### Getting the data

The API is public, CORS-enabled and cached for 60 s:

| Path | Returns |
|---|---|
| `/api/summary?days=7[&route=<route_id>]` | `total`, `histogram` (`{bin, n}`), `byDay`, `byHour`, `byMode`, `routes` (each with `n`, `unmatched`, `unmatchedShare`, `medianMin`, `p10Min`, `p90Min`, `meanMin`, `early`, `onTime`, `late`), `coverage`, `thresholds`; `days` ≤ 90 |
| `/api/recent?limit=50[&route=<route_id>]` | per-departure rows (`trip_id`, `vehicle_id`, `route_id`, `short_name`, `headsign`, `planned_ts`, `actual_ts`, `delta_s`, Unix seconds), `limit` ≤ 200 |

With access to the Cloudflare account, the raw rows can be queried directly (per-departure rows are kept for 45 days, the histograms forever):

```sh
npx wrangler d1 execute punctuality --remote --command \
  "SELECT route_id, COUNT(*) n, AVG(delta_s) mean_s FROM departures WHERE actual_ts > unixepoch('now','-7 days') GROUP BY route_id ORDER BY n DESC"
```

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

UI strings for both languages are in [`public/i18n.js`](public/i18n.js); the static markup refers to them through `data-i18n` attributes.

## Licence

Code: [MIT](LICENSE). Published statistics: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), credit **lad.lviv.ua**. GTFS static and vehicle positions belong to the Lviv operator.
