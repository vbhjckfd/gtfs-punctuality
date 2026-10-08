const $ = (id) => document.getElementById(id);
const state = { days: 7, route: null, sort: "n", dir: -1, data: null };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(0)}%`);
const min = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${x}`);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load() {
  $("status").textContent = "loading…";
  const q = new URLSearchParams({ days: state.days });
  if (state.route) q.set("route", state.route);
  const [s, r] = await Promise.all([
    fetch(`/api/summary?${q}`).then((x) => x.json()),
    fetch(`/api/recent?${state.route ? `route=${encodeURIComponent(state.route)}&` : ""}limit=40`).then((x) => x.json()),
  ]);
  state.data = s;
  render(s, r.departures);
  $("status").textContent = "";
}

function render(s, recent) {
  $("filter").hidden = !state.route;
  $("routes-card").hidden = !!state.route;
  const t = s.total;
  if (!t.n) {
    $("kpis").innerHTML = `<div class="kpi"><div class="v">0</div><div class="l">no measured departures in this window yet</div></div>`;
    for (const id of ["hist", "hours", "days-chart"]) $(id).innerHTML = "";
    $("recent").innerHTML = "";
    return;
  }
  const kpi = (v, l, c = "") => `<div class="kpi"><div class="v ${c}">${v}</div><div class="l">${l}</div></div>`;
  const cov = s.coverage.opened ? Math.round((100 * s.coverage.confirmed) / s.coverage.opened) : null;
  $("kpis").innerHTML = [
    kpi(t.n.toLocaleString("en"), "departures measured"),
    kpi(`${min(t.medianMin)} min`, "median error"),
    kpi(pct(t.onTime), "on time (−1…+5 min)", "ok"),
    kpi(pct(t.early), "early (> 1 min)", "early"),
    kpi(pct(t.late), "late (> 5 min)", "late"),
    kpi(`${min(t.p10Min)} … ${min(t.p90Min)}`, "10th–90th percentile, min"),
    cov == null ? "" : kpi(`${cov}%`, "of observed terminus stops resolved to a departure"),
  ].join("");
  drawHistogram($("hist"), s.histogram);
  drawBars($("hours"), s.byHour.map((h) => ({ label: String(h.hour), v: h.onTime, n: h.n })), "on-time share");
  drawBars($("days-chart"), s.byDay.map((d) => ({ label: d.day.slice(5), v: d.onTime, n: d.n })), "on-time share");
  if (s.routes) drawRoutes(s.routes);
  $("recent").innerHTML = `<thead><tr><th>Route</th><th>Headsign</th><th>Planned</th><th>Actual</th><th>Error</th></tr></thead><tbody>${recent.map((d) => {
    const m = Math.round(d.delta_s / 60);
    const c = m <= -2 ? "early" : m >= 6 ? "late" : "ok";
    return `<tr><td>${esc(d.short_name)}</td><td>${esc(d.headsign)}</td><td>${fmtTime(d.planned_ts)}</td><td>${fmtTime(d.actual_ts)}</td><td class="${c}">${d.delta_s > 0 ? "+" : ""}${(d.delta_s / 60).toFixed(1)} min</td></tr>`;
  }).join("")}</tbody>`;
}

function drawHistogram(el, hist) {
  const lo = -30, hi = 30, W = 900, H = 200, pad = { l: 36, r: 8, t: 8, b: 24 };
  const byBin = new Map();
  for (const h of hist) byBin.set(Math.max(lo, Math.min(hi, h.bin)), (byBin.get(Math.max(lo, Math.min(hi, h.bin))) ?? 0) + h.n);
  const max = Math.max(...byBin.values());
  const bw = (W - pad.l - pad.r) / (hi - lo + 1);
  let out = "";
  for (let b = lo; b <= hi; b++) {
    const n = byBin.get(b) ?? 0;
    const h = (n / max) * (H - pad.t - pad.b);
    const fill = b <= -2 ? "var(--early)" : b >= 6 ? "var(--late)" : "var(--ok)";
    out += `<rect x="${pad.l + (b - lo) * bw + 1}" y="${H - pad.b - h}" width="${bw - 2}" height="${h}" fill="${fill}"><title>${b} min: ${n}</title></rect>`;
  }
  for (const b of [-30, -20, -10, 0, 10, 20, 30]) out += `<text x="${pad.l + (b - lo + 0.5) * bw}" y="${H - 6}" text-anchor="middle">${b === lo ? "≤" : b === hi ? "≥" : ""}${b}</text>`;
  out += `<text x="4" y="14">${max}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of departure error in minutes">${out}</svg>`;
}

function drawBars(el, items, label) {
  if (!items.length) { el.innerHTML = ""; return; }
  const W = 480, H = 170, pad = { l: 30, r: 4, t: 8, b: 22 };
  const bw = (W - pad.l - pad.r) / items.length;
  let out = "";
  for (const y of [0, 0.5, 1]) out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b - y * (H - pad.t - pad.b)}" y2="${H - pad.b - y * (H - pad.t - pad.b)}" stroke="var(--line)"/><text x="2" y="${H - pad.b - y * (H - pad.t - pad.b) + 4}">${y * 100}%</text>`;
  items.forEach((it, i) => {
    const h = it.v * (H - pad.t - pad.b);
    out += `<rect x="${pad.l + i * bw + 1}" y="${H - pad.b - h}" width="${Math.max(1, bw - 2)}" height="${h}" fill="var(--ok)" opacity="${it.n < 20 ? 0.4 : 1}"><title>${it.label}: ${(it.v * 100).toFixed(0)}% ${label} (n=${it.n})</title></rect>`;
    if (items.length <= 24 || i % Math.ceil(items.length / 12) === 0) out += `<text x="${pad.l + (i + 0.5) * bw}" y="${H - 6}" text-anchor="middle">${it.label}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${out}</svg>`;
}

function drawRoutes(rows) {
  const cols = [["shortName", "Route"], ["n", "Departures"], ["medianMin", "Median"], ["p10Min", "P10"], ["p90Min", "P90"], ["early", "Early"], ["onTime", "On time"], ["late", "Late"]];
  const sorted = [...rows].sort((a, b) => (typeof a[state.sort] === "string" ? a[state.sort].localeCompare(b[state.sort]) : a[state.sort] - b[state.sort]) * state.dir);
  const cell = (k, r) => (k === "shortName" ? esc(r.shortName) : ["early", "onTime", "late"].includes(k) ? `<span class="${k === "early" ? "early" : k === "late" ? "late" : "ok"}">${pct(r[k])}</span>` : k.endsWith("Min") ? min(r[k]) : r[k]);
  $("routes").innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${state.sort === k ? (state.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((r) => `<tr class="click" data-route="${esc(r.route_id)}" data-name="${esc(r.shortName)}">${cols.map(([k]) => `<td>${cell(k, r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

$("days").addEventListener("change", (e) => { state.days = +e.target.value; load(); });
$("clear").addEventListener("click", () => { state.route = null; load(); });
$("routes").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (th) { const k = th.dataset.k; state.dir = state.sort === k ? -state.dir : k === "shortName" ? 1 : -1; state.sort = k; drawRoutes(state.data.routes); return; }
  const tr = e.target.closest("tr[data-route]");
  if (tr) { state.route = tr.dataset.route; $("filter-name").textContent = tr.dataset.name; load(); scrollTo({ top: 0, behavior: "smooth" }); }
});
load().catch((e) => { $("status").textContent = `failed to load: ${e.message}`; });
