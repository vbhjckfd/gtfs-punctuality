// Departure detection from a stream of (timestamp, distance-to-first-stop)
// observations of one vehicle running one trip.
//
// A departure counts only if the vehicle was standing at the first stop, then
// drove off and was seen well down the road soon after. Validated against
// raw GTFS-RT archives: without the confirmation step, buses that shuffle
// 300 m along the kerb to a layover spot read as "departed 20 minutes early".
//
//   at stop (d <= IN_RADIUS)  ──leaves, next fix within MAX_GAP──▶  candidate
//   candidate ──a fix beyond CONFIRM_DIST within CONFIRM_WITHIN──▶  confirmed
//   candidate ──timeout, or back at the stop──▶  dropped, wait for the next pass

export const IN_RADIUS = 50;        // m: "standing at the first stop"
export const MAX_GAP = 90;          // s: longest gap between the last fix at the stop and the first fix beyond it
export const CONFIRM_DIST = 1000;   // m: proof the vehicle really set off
export const CONFIRM_WITHIN = 600;  // s: ...within this time of leaving
export const MAX_STALE = 120;       // s: ignore entities older than the feed header by more than this

/**
 * @param {object|null} st  persisted row (or null before the first fix at the stop)
 * @param {{ts:number,d:number}} obs
 * @param {number} planned  planned departure, unix seconds
 * @returns {object|null} next state; the same object if nothing changed; null if the fix is irrelevant
 */
export function step(st, obs, planned) {
  const { ts, d } = obs;
  if (!st) {
    if (d > IN_RADIUS) return null;
    return { first_seen: ts, last_in_ts: ts, last_in_d: d, last_ts: ts, cross_ts: null, cross_obs_ts: null, actual_ts: null, delta_s: null };
  }
  if (st.actual_ts != null || ts <= st.last_ts) return st;

  const next = { ...st, last_ts: ts };
  if (d <= IN_RADIUS) {
    next.last_in_ts = ts;
    next.last_in_d = d;
    next.cross_ts = null;
    next.cross_obs_ts = null;
    return next;
  }

  if (next.cross_ts == null) {
    // First fix beyond the radius after being inside: interpolate the crossing.
    const gap = ts - st.last_in_ts;
    if (st.last_ts === st.last_in_ts && gap <= MAX_GAP) {
      const f = Math.min(1, Math.max(0, (IN_RADIUS - st.last_in_d) / (d - st.last_in_d)));
      next.cross_ts = Math.round(st.last_in_ts + f * gap);
      next.cross_obs_ts = ts;
    }
  } else if (ts - next.cross_obs_ts > CONFIRM_WITHIN) {
    next.cross_ts = null;
    next.cross_obs_ts = null;
  }

  if (next.cross_ts != null && d > CONFIRM_DIST && ts - next.cross_obs_ts <= CONFIRM_WITHIN) {
    next.actual_ts = next.cross_ts;
    next.delta_s = next.actual_ts - planned;
  }
  return next;
}
