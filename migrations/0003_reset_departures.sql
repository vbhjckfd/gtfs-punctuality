-- Retention drops 45 -> 7 days. Pruning ~210k rows with DELETE would write ~420k
-- rows (row + index entry each) and trip the 100k/day D1 free cap, so start over.
-- Aggregates (hist, hist_hour, coverage) are untouched.
DROP TABLE departures;
CREATE TABLE departures (
  trip_id      TEXT NOT NULL,
  planned_ts   INTEGER NOT NULL,
  vehicle_id   TEXT NOT NULL,
  route_id     TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_in_ts   INTEGER NOT NULL,
  last_in_d    REAL NOT NULL,
  last_ts      INTEGER NOT NULL,
  cross_ts     INTEGER,
  cross_obs_ts INTEGER,
  actual_ts    INTEGER,
  delta_s      INTEGER,
  PRIMARY KEY (trip_id, planned_ts, vehicle_id)
) WITHOUT ROWID;
CREATE INDEX departures_recent ON departures (actual_ts) WHERE actual_ts IS NOT NULL;
