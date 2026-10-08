#!/usr/bin/env node
// Load the GTFS static schedule into D1: routes, and per trip the first stop
// (coordinates + planned departure). Heavy parsing lives here, not in the
// Worker, because stop_times.txt is ~17 MB.
//
//   node scripts/import-static.mjs                 # download upstream, import to remote D1
//   node scripts/import-static.mjs --file x.zip    # use a local archive
//   node scripts/import-static.mjs --local         # target the local dev database
//   node scripts/import-static.mjs --force         # import even if the archive is unchanged
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const URL_STATIC = process.env.GTFS_STATIC_URL ?? "https://track.ua-gis.com/gtfs/lviv/static.zip";
const DB = "punctuality";
const target = flag("local") ? "--local" : "--remote";
const tmp = join(process.cwd(), "tmp");
mkdirSync(tmp, { recursive: true });

const wrangler = (...a) => execFileSync("npx", ["wrangler", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 28 });
const query = (sql) => JSON.parse(wrangler("d1", "execute", DB, target, "--json", "--command", sql))[0].results;

// --- fetch archive --------------------------------------------------------
let zip;
if (opt("file")) zip = readFileSync(opt("file"));
else {
  const res = await fetch(URL_STATIC);
  if (!res.ok) throw new Error(`static download failed: ${res.status}`);
  zip = Buffer.from(await res.arrayBuffer());
}
const sha = createHash("sha256").update(zip).digest("hex").slice(0, 16);
const zipPath = join(tmp, "static.zip");
writeFileSync(zipPath, zip);

if (!flag("force")) {
  const cur = query("SELECT v FROM meta WHERE k='static_sha'")[0]?.v;
  if (cur === sha) { console.log(`static unchanged (${sha}), nothing to do`); process.exit(0); }
}

// --- parse ----------------------------------------------------------------
const read = (name) => execFileSync("unzip", ["-p", zipPath, name], { encoding: "utf8", maxBuffer: 1 << 29 }).replace(/^﻿/, "");

function* rows(text) {
  const lines = text.split(/\r?\n/);
  const head = splitCsv(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = splitCsv(lines[i]);
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = f[j] ?? "";
    yield o;
  }
}

function splitCsv(line) {
  if (!line.includes('"')) return line.split(",");
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const sec = (t) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
const esc = (v) => (v == null || v === "" ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

const stops = new Map();
for (const r of rows(read("stops.txt"))) stops.set(r.stop_id, [Number(r.stop_lat), Number(r.stop_lon)]);

const first = new Map(); // trip_id -> { seq, stop, dep }
for (const r of rows(read("stop_times.txt"))) {
  const seq = Number(r.stop_sequence);
  const cur = first.get(r.trip_id);
  if (!cur || seq < cur.seq) first.set(r.trip_id, { seq, stop: r.stop_id, dep: r.departure_time || r.arrival_time });
}

const routes = [...rows(read("routes.txt"))].map((r) => `(${esc(r.route_id)},${esc(r.route_short_name)},${Number(r.route_type)})`);
const trips = [];
let skipped = 0;
for (const r of rows(read("trips.txt"))) {
  const f = first.get(r.trip_id);
  const xy = f && stops.get(f.stop);
  if (!f || !xy || !f.dep) { skipped++; continue; }
  trips.push(`(${esc(r.trip_id)},${esc(r.route_id)},${r.direction_id === "" ? "NULL" : Number(r.direction_id)},${esc(r.trip_headsign)},${esc(f.stop)},${xy[0]},${xy[1]},${sec(f.dep)})`);
}
console.log(`${routes.length} routes, ${trips.length} trips (${skipped} skipped without a usable first stop)`);

// --- write SQL, load ------------------------------------------------------
const sql = ["DELETE FROM trips;", "DELETE FROM routes;"];
for (let i = 0; i < routes.length; i += 200) sql.push(`INSERT INTO routes (route_id, short_name, route_type) VALUES ${routes.slice(i, i + 200).join(",")};`);
for (let i = 0; i < trips.length; i += 200) sql.push(`INSERT INTO trips (trip_id, route_id, direction_id, headsign, first_stop_id, first_lat, first_lon, first_dep_sec) VALUES ${trips.slice(i, i + 200).join(",")};`);
sql.push(`INSERT INTO meta (k, v) VALUES ('static_sha', '${sha}') ON CONFLICT (k) DO UPDATE SET v = excluded.v;`);
sql.push(`INSERT INTO meta (k, v) VALUES ('static_imported_at', '${new Date().toISOString()}') ON CONFLICT (k) DO UPDATE SET v = excluded.v;`);
const sqlPath = join(tmp, "static.sql");
writeFileSync(sqlPath, sql.join("\n"));
wrangler("d1", "execute", DB, target, "--yes", "--file", sqlPath);
rmSync(sqlPath);
console.log(`imported static ${sha}`);
