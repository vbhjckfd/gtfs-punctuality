# /// script
# dependencies = ["pillow"]
# ///
"""Render public/og.png (1200x630 share image) from the live /api/summary.

    uv run scripts/og.py [base-url]   # default https://punctuality.lad.lviv.ua

The numbers are baked in; re-run and deploy to refresh them.
Fonts are Inter subsets (SIL OFL, see og-fonts/OFL.txt).
"""
import sys, json, pathlib, urllib.request
from PIL import Image, ImageDraw, ImageFont
HERE = pathlib.Path(__file__).resolve().parent
F, out = HERE / "og-fonts", HERE.parent / "public" / "og.png"
base = (sys.argv[1] if len(sys.argv) > 1 else "https://punctuality.lad.lviv.ua").rstrip("/")
req = urllib.request.Request(f"{base}/api/summary?days=30", headers={"User-Agent": "gtfs-punctuality-og"})
s = json.load(urllib.request.urlopen(req, timeout=30))
W, H = 1200, 630
BG, INK, MUT, LINE = "#fafaf7", "#1c1c1a", "#6b6b66", "#e4e3dd"
EARLY, OK, LATE = "#3b82c4", "#2f9e6b", "#d4553a"
img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
bold = lambda z: ImageFont.truetype(f"{F}/Inter-800ExtraBold.ttf", z)
med = lambda z: ImageFont.truetype(f"{F}/Inter-500Medium.ttf", z)
d.rectangle((72, 72, 132, 87), fill="#0057b7"); d.rectangle((72, 87, 132, 102), fill="#ffd700")
d.text((150, 69), "punctuality.lad.lviv.ua", font=med(30), fill=MUT)
d.text((70, 140), "Do Lviv buses leave", font=bold(58), fill=INK)
d.text((70, 208), "on time?", font=bold(58), fill=INK)
d.text((72, 300), "Terminus departures vs the GTFS timetable,", font=med(26), fill=MUT)
d.text((72, 334), "measured from live vehicle positions.", font=med(26), fill=MUT)
t = s["total"]
for i, (v, lab, c) in enumerate([(t["onTime"], "on time", OK), (t["early"], "early", EARLY), (t["late"], "late", LATE)]):
    x = 72 + i * 175
    d.text((x, 410), f"{round(v*100)}%", font=bold(60), fill=c)
    d.text((x + 2, 482), lab, font=med(24), fill=MUT)
d.text((72, 545), f"{t['n']:,} departures, last {s['days']} days · ±2 min = on time", font=med(20), fill=MUT)
# histogram -15..+15 min on the right
hist = {b["bin"]: b["n"] for b in s["histogram"]}
bins = list(range(-15, 16)); mx = max(hist.get(b, 0) for b in bins)
x0, x1, yb, ht = 770, 1130, 520, 330
bw = (x1 - x0) / len(bins)
d.line((x0, yb, x1, yb), fill=LINE, width=2)
for i, b in enumerate(bins):
    h = ht * hist.get(b, 0) / mx
    c = EARLY if b < -2 else LATE if b > 2 else OK
    d.rectangle((x0 + i * bw + 2, yb - h, x0 + (i + 1) * bw - 2, yb - 1), fill=c)
for b, lab in [(-15, "-15 min"), (0, "0"), (15, "+15 min")]:
    cx = x0 + (b + 15 + 0.5) * bw
    f = med(20); w = d.textlength(lab, font=f)
    d.text((cx - (w / 2 if b == 0 else w - bw / 2 if b == 15 else bw / 2), yb + 12), lab, font=f, fill=MUT)
d.text((x0, yb - ht - 40), "early", font=med(22), fill=EARLY)
d.text((x1 - d.textlength("late", font=med(22)), yb - ht - 40), "late", font=med(22), fill=LATE)
img.save(out, optimize=True)
