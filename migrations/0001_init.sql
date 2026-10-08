-- Schedule, imported from GTFS static by scripts/import-static.mjs.
CREATE TABLE routes (
  route_id   TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,
  route_type INTEGER NOT NULL
);

-- One row per trip: only what departure detection needs about the first stop.
CREATE TABLE trips (
  trip_id        TEXT PRIMARY KEY,
  route_id       TEXT NOT NULL,
  direction_id   INTEGER,
  headsign       TEXT,
  first_stop_id  TEXT NOT NULL,
  first_lat      REAL NOT NULL,
  first_lon      REAL NOT NULL,
  first_dep_sec  INTEGER NOT NULL      -- seconds after local midnight; may exceed 86400
);

-- One row per (trip, planned departure, vehicle) the moment a vehicle is seen
-- standing at the trip's first stop. actual_ts is filled once it has driven off.
CREATE TABLE departures (
  trip_id      TEXT NOT NULL,
  planned_ts   INTEGER NOT NULL,       -- unix seconds, planned departure from the first stop
  vehicle_id   TEXT NOT NULL,
  route_id     TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,       -- first observation within the stop radius
  last_in_ts   INTEGER NOT NULL,       -- latest observation within the stop radius
  last_in_d    REAL NOT NULL,          -- its distance from the stop, m
  last_ts      INTEGER NOT NULL,       -- latest observation consumed (dedup / ordering)
  cross_ts     INTEGER,                -- candidate departure, waiting to be confirmed
  cross_obs_ts INTEGER,
  actual_ts    INTEGER,                -- confirmed departure
  delta_s      INTEGER,                -- actual_ts - planned_ts (positive = late)
  PRIMARY KEY (trip_id, planned_ts, vehicle_id)
) WITHOUT ROWID;
CREATE INDEX departures_recent ON departures (actual_ts) WHERE actual_ts IS NOT NULL;
CREATE INDEX departures_route  ON departures (route_id, actual_ts) WHERE actual_ts IS NOT NULL;

-- Aggregates maintained as departures are confirmed. bin = round(delta / 60 s),
-- clamped to -60..60. The dashboard reads only these tables, so a query costs
-- thousands of rows however many departures there are.
CREATE TABLE hist (
  day      TEXT NOT NULL,              -- Kyiv date of the planned departure
  route_id TEXT NOT NULL,
  bin      INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (day, route_id, bin)
) WITHOUT ROWID;

CREATE TABLE hist_hour (
  day  TEXT NOT NULL,
  hour INTEGER NOT NULL,               -- Kyiv hour of the planned departure
  bin  INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (day, hour, bin)
) WITHOUT ROWID;

-- Detection coverage: how many trips the collector saw at the terminus at all.
CREATE TABLE coverage (
  day        TEXT PRIMARY KEY,
  seen       INTEGER NOT NULL DEFAULT 0,   -- departures rows opened
  confirmed  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
