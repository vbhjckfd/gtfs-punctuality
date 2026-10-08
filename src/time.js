// Europe/Kyiv wall-clock helpers. Schedule times in GTFS are local to the agency.
const TZ = "Europe/Kyiv";
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Offset of Kyiv from UTC at the given instant, in seconds. */
export function kyivOffset(unix) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(unix * 1000))) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
  return Math.round(asUtc - unix);
}

// Intl formatting is slow and plannedTs runs once per vehicle fix. Kyiv's UTC
// offset is a whole number of hours, so local midnight always falls on a UTC
// hour boundary and an hour bucket never straddles two Kyiv days.
const dayCache = new Map();

/** Unix time of Kyiv local midnight of the Kyiv day containing `unix`, plus the day as YYYY-MM-DD. */
export function kyivDay(unix) {
  const bucket = Math.floor(unix / 3600);
  let hit = dayCache.get(bucket);
  if (!hit) {
    if (dayCache.size > 2000) dayCache.clear();
    hit = computeKyivDay(bucket * 3600);
    dayCache.set(bucket, hit);
  }
  return hit;
}

function computeKyivDay(unix) {
  const off = kyivOffset(unix);
  const local = unix + off;
  const midLocal = local - (((local % 86400) + 86400) % 86400);
  const midUnix = midLocal - kyivOffset(midLocal - off); // offset valid at midnight, not at `unix`
  return { midnight: midUnix, day: new Date(midLocal * 1000).toISOString().slice(0, 10) };
}

export function kyivHour(unix) {
  return Math.floor((((unix + kyivOffset(unix)) % 86400) + 86400) % 86400 / 3600);
}

/**
 * Planned departure instant for a trip observed at `obsTs`. GTFS times run past
 * 24:00 for trips after midnight, so a bus seen at 00:10 may belong to
 * yesterday's service day, and a bus waiting at 23:50 for a 00:30 departure
 * belongs to tomorrow's. Of the three candidates take the closest.
 */
export function plannedTs(obsTs, firstDepSec) {
  const today = kyivDay(obsTs);
  const yesterday = kyivDay(today.midnight - 3600);
  const tomorrow = kyivDay(today.midnight + 26 * 3600); // +26 h clears a DST day
  let best = today.midnight + firstDepSec;
  for (const c of [yesterday.midnight + firstDepSec, tomorrow.midnight + firstDepSec]) {
    if (Math.abs(obsTs - c) < Math.abs(obsTs - best)) best = c;
  }
  return best;
}
