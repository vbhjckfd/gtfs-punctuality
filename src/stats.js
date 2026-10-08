// Summaries computed from one-minute histogram bins (bin = round(delta / 60 s)).
// On time = -1..+5 min, the usual transit-agency window; early / late are the
// bins either side of it.
//
// A departure more than UNMATCHED_MIN off its planned time is more likely a
// vehicle carrying another trip's id than a bus that really left half an hour
// early, so it is counted apart and kept out of every other figure.
export const EARLY_MAX = -2;
export const LATE_MIN = 6;
export const UNMATCHED_MIN = 30;

export const isUnmatched = (bin) => Math.abs(bin) > UNMATCHED_MIN;

/** @param {Array<{bin:number,n:number}>} rows */
export function summarize(rows) {
  const bins = new Map();
  let n = 0, unmatched = 0;
  for (const r of rows) {
    if (isUnmatched(r.bin)) { unmatched += r.n; continue; }
    bins.set(r.bin, (bins.get(r.bin) ?? 0) + r.n);
    n += r.n;
  }
  const all = n + unmatched;
  const base = { n, unmatched, unmatchedShare: all ? +(unmatched / all).toFixed(4) : 0 };
  if (!n) return base;
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  const pct = (q) => {
    const target = q * n;
    let acc = 0;
    for (const [bin, c] of sorted) { acc += c; if (acc >= target) return bin; }
    return sorted[sorted.length - 1][0];
  };
  let early = 0, late = 0, sum = 0;
  for (const [bin, c] of sorted) {
    if (bin <= EARLY_MAX) early += c;
    else if (bin >= LATE_MIN) late += c;
    sum += bin * c;
  }
  return {
    ...base,
    medianMin: pct(0.5), p10Min: pct(0.1), p90Min: pct(0.9), meanMin: +(sum / n).toFixed(2),
    early: +(early / n).toFixed(4), late: +(late / n).toFixed(4), onTime: +(1 - (early + late) / n).toFixed(4),
  };
}

/** Group rows by `key` and summarize each group. */
export function summarizeBy(rows, key, extra = () => ({})) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r[key]);
    if (g) g.push(r); else groups.set(r[key], [r]);
  }
  return [...groups.entries()].map(([k, g]) => ({ [key]: k, ...extra(k, g[0]), ...summarize(g) }));
}

/**
 * Lviv publishes trolleybuses as route_type 3 (bus) with a "Тр" prefix, so the
 * type alone can't tell them apart.
 */
export function routeMode(routeType, shortName) {
  if (routeType === 0) return "tram";
  if (routeType === 11 || /^Тр/.test(shortName ?? "")) return "trolleybus";
  return "bus";
}
