import { describe, it, expect } from "vitest";
import { step } from "../src/detect.js";

const run = (obs, planned = 1000) => {
  let st = null;
  for (const [ts, d] of obs) st = step(st, { ts, d }, planned) ?? st;
  return st;
};

describe("departure detection", () => {
  it("ignores a vehicle first seen away from the stop", () => {
    expect(run([[100, 400], [110, 600]])).toBeNull();
  });

  it("confirms a clean departure and interpolates the crossing", () => {
    const st = run([[100, 10], [110, 10], [120, 40], [130, 90], [140, 400], [150, 1100]], 90);
    expect(st.actual_ts).toBe(122); // 40 m @120 → 90 m @130 crosses 50 m a fifth of the way
    expect(st.delta_s).toBe(32);
  });

  it("does not count a short shuffle along the kerb", () => {
    const st = run([[100, 10], [110, 60], [120, 300], [130, 350], [800, 350], [810, 350]]);
    expect(st.actual_ts).toBeNull();
  });

  it("restarts when the vehicle comes back, then confirms the later departure", () => {
    const st = run([[100, 10], [110, 120], [120, 20], [1000, 20], [1010, 70], [1020, 500], [1030, 1500]]);
    expect(st.actual_ts).toBeGreaterThan(1000);
    expect(st.actual_ts).toBeLessThanOrEqual(1010);
  });

  it("rejects a departure across a long reporting gap", () => {
    const st = run([[100, 10], [400, 800], [410, 1500]]);
    expect(st.actual_ts).toBeNull();
  });

  it("is idempotent for repeated and out-of-order fixes", () => {
    const st = run([[100, 10], [110, 10], [105, 900], [110, 10]]);
    expect(st.last_ts).toBe(110);
  });

  it("freezes once confirmed", () => {
    const st = run([[100, 10], [110, 80], [120, 1200], [130, 5], [140, 5]]);
    expect(st.actual_ts).not.toBeNull();
    expect(st.last_ts).toBe(120);
  });
});
