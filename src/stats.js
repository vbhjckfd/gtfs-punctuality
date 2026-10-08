// Summaries computed from one-minute histogram bins (bin = round(delta / 60 s)).
// On time = -1..+5 min, the usual transit-agency window; early / late are the
// bins either side of it.
export const EARLY_MAX = -2;
export const LATE_MIN = 6;

/** @param {Array<{bin:number,n:number}>} rows */
export function summarize(rows) {
  const bins = new Map();
  let n = 0;
  for (const r of rows) { bins.set(r.bin, (bins.get(r.bin) ?? 0) + r.n); n += r.n; }
  if (!n) return { n: 0 };
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
    n,
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
  return [...groups.entries()].map(([k, g]) => ({ [key]: k, ...extra(k), ...summarize(g) }));
}
