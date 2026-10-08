-- Departures are now written once, on confirmation (pending state lives in the
-- Processor Durable Object). The route index cost one extra row write per
-- departure; route-filtered "recent" lists scan departures_recent instead.
DROP INDEX IF EXISTS departures_route;

-- Rows left pending by the first version are never completed now.
DELETE FROM departures WHERE actual_ts IS NULL;
