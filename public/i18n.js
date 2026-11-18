// UI strings. Static markup carries data-i18n (text) or data-i18n-html (trusted
// markup) keys; app.js renders everything else through t().
const STRINGS = {
  en: {
    locale: "en-GB",
    title: "Lviv departure punctuality",
    description: "How late or early Lviv buses really leave the terminus, compared with the GTFS timetable.",
    h1: "Lviv terminus departures: actual vs timetable",
    sub: "Measured from archived GTFS-RT vehicle positions against the planned first-stop time in GTFS static.",
    window: "Window",
    today: "today",
    days: (n) => `${n} days`,
    route: "route",
    histTitle: "Departure error distribution",
    byHour: "By hour of day",
    byDay: "By day",
    byMode: "By mode",
    routes: "Routes",
    recentTitle: "Latest measured departures",
    methodology: `<b>How it is measured.</b> A departure counts when a vehicle running a trip is seen within 50 m of that trip's first stop, then drives off and is seen more than 1 km away within 10 minutes. The crossing instant is interpolated between GPS fixes (about 10 s apart). Buses that only shuffle along the kerb, or that vanish from the feed, are not counted. On time = within ±1 min of the plan. Departures more than 30 min off are reported as unmatched and kept out of the medians and shares. <a href="https://github.com/vbhjckfd/gtfs-punctuality#for-data-analysts">Full methodology</a>.`,
    dataLine: `Data: <a href="https://github.com/vbhjckfd/gtfs-collector">gtfs-collector</a> archive · <a href="https://github.com/vbhjckfd/gtfs-punctuality">source</a>`,
    loading: "loading…",
    failed: (m) => `failed to load: ${m}`,
    noData: "no measured departures in this window yet",
    min: "min",
    kpiMeasured: "departures measured",
    kpiMedian: "median error",
    kpiOnTime: (w) => `on time (${w})`,
    kpiEarly: (m) => `early (> ${m} min)`,
    kpiLate: (m) => `late (> ${m} min)`,
    kpiSpread: "10th–90th percentile, min",
    kpiUnmatched: (lim, n) => `unmatched: > ${lim} min off the plan, left out of the figures above (${n})`,
    kpiCoverage: "of observed terminus stops resolved to a departure",
    histNote: (w, lim) => `Minutes after (+) or before (−) the planned time. On time = ${w} (whole-minute bins, so under 90 s off). The grey bars at either end (“?”) are departures more than ${lim} min off the plan: most likely a vehicle carrying another trip's id, so they are left out of every figure.`,
    histAria: "Distribution of departure error in minutes",
    tipEarlyOff: (lim) => `more than ${lim} min early: unmatched`,
    tipLateOff: (lim) => `more than ${lim} min late: unmatched`,
    tipOnMinute: "on the minute (±30 s)",
    tipOtherTrip: "probably another trip's id, not counted",
    nDepartures: (n) => `${n} departures`,
    early: "early",
    late: "late",
    onTime: "on time",
    onTimeShare: "on-time share",
    few: "(few — unreliable)",
    offTip: (lim) => `More than ${lim} min off: probably another trip's id, not counted`,
    colRoute: "Route", colHeadsign: "Headsign", colPlanned: "Planned", colActual: "Actual", colError: "Error",
    colMode: "Mode", colDepartures: "Departures", colMedian: "Median", colEarly: "Early", colOnTime: "On time", colLate: "Late", colUnmatched: "Unmatched",
    mode: { tram: "Tram", trolleybus: "Trolleybus", bus: "Bus" },
  },
  uk: {
    locale: "uk-UA",
    title: "Пунктуальність відправлень у Львові",
    description: "Наскільки пізно чи рано львівський транспорт насправді вирушає з кінцевої порівняно з розкладом GTFS.",
    h1: "Відправлення з кінцевих у Львові: факт і розклад",
    sub: "Виміряно за архівом позицій транспорту GTFS-RT порівняно з плановим часом відправлення з першої зупинки в GTFS static.",
    window: "Період",
    today: "сьогодні",
    days: (n) => `${n} днів`,
    route: "маршрут",
    histTitle: "Розподіл відхилень відправлень",
    byHour: "За годиною доби",
    byDay: "За днями",
    byMode: "За видом транспорту",
    routes: "Маршрути",
    recentTitle: "Останні виміряні відправлення",
    methodology: `<b>Як це виміряно.</b> Відправлення зараховується, коли машину, що виконує рейс, помічено в межах 50 м від першої зупинки цього рейсу, а потім вона від'їжджає і протягом 10 хвилин її помічено далі ніж за 1 км. Момент перетину інтерполюється між GPS-позначками (приблизно кожні 10 с). Машини, що лише переставляються вздовж бордюру або зникають із потоку даних, не враховуються. Вчасно = в межах ±1 хв від плану. Відправлення з відхиленням понад 30 хв позначаються як незіставлені й не входять до медіан і часток. <a href="https://github.com/vbhjckfd/gtfs-punctuality/blob/main/README.uk.md#для-аналітиків-даних">Повна методологія</a>.`,
    dataLine: `Дані: архів <a href="https://github.com/vbhjckfd/gtfs-collector">gtfs-collector</a> · <a href="https://github.com/vbhjckfd/gtfs-punctuality">код</a>`,
    loading: "завантаження…",
    failed: (m) => `не вдалося завантажити: ${m}`,
    noData: "за цей період ще немає виміряних відправлень",
    min: "хв",
    kpiMeasured: "виміряних відправлень",
    kpiMedian: "медіана відхилення",
    kpiOnTime: (w) => `вчасно (${w})`,
    kpiEarly: (m) => `раніше (> ${m} хв)`,
    kpiLate: (m) => `пізніше (> ${m} хв)`,
    kpiSpread: "10–90-й перцентиль, хв",
    kpiUnmatched: (lim, n) => `незіставлені: > ${lim} хв від плану, не входять до показників вище (${n})`,
    kpiCoverage: "стоянок на кінцевій завершились зафіксованим відправленням",
    histNote: (w, lim) => `Хвилини після (+) або до (−) планового часу. Вчасно = ${w} (стовпці по цілих хвилинах, тобто відхилення менше 90 с). Сірі стовпці з обох боків («?») — відправлення з відхиленням понад ${lim} хв: найімовірніше, машина передає ідентифікатор іншого рейсу, тому їх не враховано в жодному показнику.`,
    histAria: "Розподіл відхилень відправлень у хвилинах",
    tipEarlyOff: (lim) => `раніше ніж на ${lim} хв: незіставлене`,
    tipLateOff: (lim) => `пізніше ніж на ${lim} хв: незіставлене`,
    tipOnMinute: "хвилина в хвилину (±30 с)",
    tipOtherTrip: "імовірно, ідентифікатор іншого рейсу, не враховано",
    nDepartures: (n) => `відправлень: ${n}`,
    early: "раніше",
    late: "пізніше",
    onTime: "вчасно",
    onTimeShare: "частка вчасних",
    few: "(мало — ненадійно)",
    offTip: (lim) => `Відхилення понад ${lim} хв: імовірно, ідентифікатор іншого рейсу, не враховано`,
    colRoute: "Маршрут", colHeadsign: "Напрямок", colPlanned: "План", colActual: "Факт", colError: "Відхилення",
    colMode: "Вид", colDepartures: "Відправлень", colMedian: "Медіана", colEarly: "Раніше", colOnTime: "Вчасно", colLate: "Пізніше", colUnmatched: "Незіставлені",
    mode: { tram: "Трамвай", trolleybus: "Тролейбус", bus: "Автобус" },
  },
};

export const LANGS = Object.keys(STRINGS);
const KEY = "lang";

function initial() {
  try { const saved = localStorage.getItem(KEY); if (STRINGS[saved]) return saved; } catch {}
  // Russian-language browsers get Ukrainian, never a Russian UI.
  return (navigator.languages ?? [navigator.language]).some((l) => /^(uk|ru|be)\b/i.test(l)) ? "uk" : "en";
}

export let lang = initial();

export function t(key, ...args) {
  const v = STRINGS[lang][key] ?? STRINGS.en[key];
  return typeof v === "function" ? v(...args) : v;
}

export const num = (n, opts) => n.toLocaleString(t("locale"), opts);

/** Switch language, translate the static markup; the caller re-renders the dynamic parts. */
export function setLang(next) {
  lang = STRINGS[next] ? next : "en";
  try { localStorage.setItem(KEY, lang); } catch {}
  document.documentElement.lang = lang;
  document.title = t("title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("description"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n, el.dataset.arg);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const b of document.querySelectorAll("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}
