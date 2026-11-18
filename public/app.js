import { t, num, lang, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const state = { days: 7, route: null, sort: "n", dir: -1, data: null, recent: null };
const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(0)}%`);
const min = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${x}`);
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString(t("locale"), { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Bucket edges in minutes; overwritten from /api/summary so they follow src/stats.js.
let UNMATCHED = 30, EARLY_MAX = -2, LATE_MIN = 2;
const klass = (bin) => (Math.abs(bin) > UNMATCHED ? "muted" : bin <= EARLY_MAX ? "early" : bin >= LATE_MIN ? "late" : "ok");
const modeName = (m) => t("mode")[m] ?? esc(m);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function load() {
  $("status").textContent = t("loading");
  const q = new URLSearchParams({ days: state.days });
  if (state.route) q.set("route", state.route);
  const [s, r] = await Promise.all([
    fetch(`/api/summary?${q}`).then((x) => x.json()),
    fetch(`/api/recent?${state.route ? `route=${encodeURIComponent(state.route)}&` : ""}limit=40`).then((x) => x.json()),
  ]);
  state.data = s;
  state.recent = r.departures;
  if (s.thresholds) ({ unmatchedMin: UNMATCHED, earlyMaxMin: EARLY_MAX, lateMinMin: LATE_MIN } = s.thresholds);
  render(s, r.departures);
  $("status").textContent = "";
}

function render(s, recent) {
  $("filter").hidden = !state.route;
  $("routes-card").hidden = !!state.route;
  const tot = s.total;
  if (!tot.n) {
    $("kpis").innerHTML = `<div class="kpi"><div class="v">0</div><div class="l">${t("noData")}</div></div>`;
    for (const id of ["hist", "hours", "days-chart", "modes"]) $(id).innerHTML = "";
    $("recent").innerHTML = "";
    return;
  }
  const kpi = (v, l, c = "") => `<div class="kpi"><div class="v ${c}">${v}</div><div class="l">${l}</div></div>`;
  const cov = s.coverage.opened ? Math.round((100 * s.coverage.confirmed) / s.coverage.opened) : null;
  $("kpis").innerHTML = [
    kpi(num(tot.n), t("kpiMeasured")),
    kpi(`${min(tot.medianMin)} ${t("min")}`, t("kpiMedian")),
    kpi(pct(tot.onTime), t("kpiOnTime", fmtWindow()), "ok"),
    kpi(pct(tot.early), t("kpiEarly", -EARLY_MAX - 1), "early"),
    kpi(pct(tot.late), t("kpiLate", LATE_MIN - 1), "late"),
    kpi(`${min(tot.p10Min)} … ${min(tot.p90Min)}`, t("kpiSpread")),
    kpi(pct(tot.unmatchedShare), t("kpiUnmatched", UNMATCHED, num(tot.unmatched)), "muted-v"),
    cov == null ? "" : kpi(`${cov}%`, t("kpiCoverage")),
  ].join("");
  drawHistogram($("hist"), s.histogram);
  // optional: a cached index.html from before this element existed must not break the page
  if ($("hist-note")) $("hist-note").textContent = t("histNote", fmtWindow(), UNMATCHED);
  drawBars($("hours"), s.byHour.map((h) => ({ label: String(h.hour), title: `${String(h.hour).padStart(2, "0")}:00–${String(h.hour).padStart(2, "0")}:59`, v: h.onTime, n: h.n })), t("onTimeShare"));
  drawBars($("days-chart"), s.byDay.map((d) => ({ label: d.day.slice(5), title: d.day, v: d.onTime, n: d.n })), t("onTimeShare"));
  if (s.routes) drawRoutes(s.routes);
  $("modes-card").hidden = !s.byMode;
  if (s.byMode) drawModes(s.byMode);
  $("recent").innerHTML = `<thead><tr><th>${t("colRoute")}</th><th>${t("colHeadsign")}</th><th>${t("colPlanned")}</th><th>${t("colActual")}</th><th>${t("colError")}</th></tr></thead><tbody>${recent.map((d) => {
    const m = Math.round(d.delta_s / 60);
    const off = Math.abs(m) > UNMATCHED;
    const c = klass(m);
    return `<tr><td>${esc(d.short_name)}</td><td>${esc(d.headsign)}</td><td>${fmtTime(d.planned_ts)}</td><td>${fmtTime(d.actual_ts)}</td><td class="${c}"${off ? ` data-tip="${esc(t("offTip", UNMATCHED))}"` : ""}>${d.delta_s > 0 ? "+" : ""}${num(d.delta_s / 60, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${t("min")}${off ? " ?" : ""}</td></tr>`;
  }).join("")}</tbody>`;
}

function fmtWindow() {
  const lo = EARLY_MAX + 1, hi = LATE_MIN - 1;
  return lo === -hi ? `±${hi} ${t("min")}` : `${lo}…+${hi} ${t("min")}`;
}

function histTip(b, n, total) {
  const range = b < -UNMATCHED ? t("tipEarlyOff", UNMATCHED) : b > UNMATCHED ? t("tipLateOff", UNMATCHED) : b === 0 ? t("tipOnMinute") : `${b > 0 ? "+" : ""}${b} ${t("min")} (${t({ early: "early", late: "late", ok: "onTime" }[klass(b)])})`;
  const note = Math.abs(b) > UNMATCHED ? `\n${t("tipOtherTrip")}` : "";
  return `${range}\n${t("nDepartures", num(n))} · ${total ? ((100 * n) / total).toFixed(1) : 0}%${note}`;
}

// Bins -30..+30 one by one; everything beyond falls into one grey "unmatched" bar per side.
function drawHistogram(el, hist) {
  const lo = -UNMATCHED - 1, hi = UNMATCHED + 1, W = 900, H = 200, pad = { l: 36, r: 8, t: 8, b: 24 };
  const byBin = new Map();
  for (const h of hist) { const b = Math.max(lo, Math.min(hi, h.bin)); byBin.set(b, (byBin.get(b) ?? 0) + h.n); }
  const max = Math.max(...byBin.values());
  const total = [...byBin.values()].reduce((a, b) => a + b, 0);
  const bw = (W - pad.l - pad.r) / (hi - lo + 1);
  let out = "";
  for (let b = lo; b <= hi; b++) {
    const n = byBin.get(b) ?? 0;
    const h = (n / max) * (H - pad.t - pad.b);
    const fill = { muted: "var(--muted)", early: "var(--early)", late: "var(--late)", ok: "var(--ok)" }[klass(b)];
    out += `<rect x="${pad.l + (b - lo) * bw + 1}" y="${H - pad.b - h}" width="${bw - 2}" height="${h}" fill="${fill}" opacity="${b === lo || b === hi ? 0.55 : 1}"/><rect class="hit" x="${pad.l + (b - lo) * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" data-tip="${esc(histTip(b, n, total))}"/>`;
  }
  const x = (b) => pad.l + (b - lo + 0.5) * bw;
  for (const b of [-20, -10, 0, 10, 20]) out += `<text x="${x(b)}" y="${H - 6}" text-anchor="middle">${b}</text>`;
  out += `<text x="${x(lo)}" y="${H - 6}" text-anchor="middle">?</text><text x="${x(hi)}" y="${H - 6}" text-anchor="middle">?</text>`;
  out += `<text x="4" y="14">${max}</text>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("histAria"))}">${out}</svg>`;
}

function drawModes(rows) {
  const heads = ["colMode", "colDepartures", "colMedian", "P10", "P90", "colEarly", "colOnTime", "colLate", "colUnmatched"];
  $("modes").innerHTML = `<thead><tr>${heads.map((h) => `<th>${h.startsWith("col") ? t(h) : h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr><td>${modeName(r.mode)}</td><td>${num(r.n)}</td><td>${min(r.medianMin)}</td><td>${min(r.p10Min)}</td><td>${min(r.p90Min)}</td><td class="early">${pct(r.early)}</td><td class="ok">${pct(r.onTime)}</td><td class="late">${pct(r.late)}</td><td class="muted">${pct(r.unmatchedShare)}</td></tr>`).join("")}</tbody>`;
}

function drawBars(el, items, label) {
  if (!items.length) { el.innerHTML = ""; return; }
  const W = 480, H = 170, pad = { l: 30, r: 4, t: 8, b: 22 };
  const bw = (W - pad.l - pad.r) / items.length;
  let out = "";
  for (const y of [0, 0.5, 1]) out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b - y * (H - pad.t - pad.b)}" y2="${H - pad.b - y * (H - pad.t - pad.b)}" stroke="var(--line)"/><text x="2" y="${H - pad.b - y * (H - pad.t - pad.b) + 4}">${y * 100}%</text>`;
  items.forEach((it, i) => {
    const h = it.v * (H - pad.t - pad.b);
    out += `<rect x="${pad.l + i * bw + 1}" y="${H - pad.b - h}" width="${Math.max(1, bw - 2)}" height="${h}" fill="var(--ok)" opacity="${it.n < 20 ? 0.4 : 1}"/><rect class="hit" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" data-tip="${esc(`${it.title ?? it.label}\n${(it.v * 100).toFixed(0)}% ${label}\n${t("nDepartures", num(it.n))}${it.n < 20 ? ` ${t("few")}` : ""}`)}"/>`;
    if (items.length <= 24 || i % Math.ceil(items.length / 12) === 0) out += `<text x="${pad.l + (i + 0.5) * bw}" y="${H - 6}" text-anchor="middle">${it.label}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${out}</svg>`;
}

function drawRoutes(rows) {
  const cols = [["shortName", t("colRoute")], ["mode", t("colMode")], ["n", t("colDepartures")], ["medianMin", t("colMedian")], ["p10Min", "P10"], ["p90Min", "P90"], ["early", t("colEarly")], ["onTime", t("colOnTime")], ["late", t("colLate")], ["unmatchedShare", t("colUnmatched")]];
  const sorted = [...rows].sort((a, b) => (typeof a[state.sort] === "string" ? a[state.sort].localeCompare(b[state.sort]) : a[state.sort] - b[state.sort]) * state.dir);
  const cell = (k, r) => (k === "shortName" ? esc(r.shortName) : k === "mode" ? modeName(r.mode) : k === "unmatchedShare" ? `<span class="muted">${pct(r[k])}</span>` : ["early", "onTime", "late"].includes(k) ? `<span class="${k === "early" ? "early" : k === "late" ? "late" : "ok"}">${pct(r[k])}</span>` : k.endsWith("Min") ? min(r[k]) : num(r[k]));
  $("routes").innerHTML = `<thead><tr>${cols.map(([k, l]) => `<th data-k="${k}">${l}${state.sort === k ? (state.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((r) => `<tr class="click" data-route="${esc(r.route_id)}" data-name="${esc(r.shortName)}">${cols.map(([k]) => `<td>${cell(k, r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

$("days").addEventListener("change", (e) => { state.days = +e.target.value; load(); });
$("clear").addEventListener("click", () => { state.route = null; load(); });
$("routes").addEventListener("click", (e) => {
  const th = e.target.closest("th");
  if (th) { const k = th.dataset.k; state.dir = state.sort === k ? -state.dir : k === "shortName" || k === "mode" ? 1 : -1; state.sort = k; drawRoutes(state.data.routes); return; }
  const tr = e.target.closest("tr[data-route]");
  if (tr) { state.route = tr.dataset.route; $("filter-name").textContent = tr.dataset.name; load(); scrollTo({ top: 0, behavior: "smooth" }); }
});
for (const b of document.querySelectorAll("[data-lang]")) b.addEventListener("click", () => {
  setLang(b.dataset.lang);
  if (state.data) render(state.data, state.recent);
});
setLang(lang);
load().catch((e) => { $("status").textContent = t("failed", e.message); });

const tip = document.createElement("div");
tip.id = "tip";
tip.hidden = true;
document.body.append(tip);
document.addEventListener("mousemove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - w - 8)}px`;
  tip.style.top = `${e.clientY + 16}px`;
});
document.addEventListener("mouseleave", () => { tip.hidden = true; });
