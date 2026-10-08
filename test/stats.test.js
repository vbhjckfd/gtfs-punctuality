import { describe, it, expect } from "vitest";
import { summarize } from "../src/stats.js";

describe("summarize", () => {
  it("computes percentiles and the on-time split from minute bins", () => {
    const s = summarize([{ bin: -5, n: 10 }, { bin: 0, n: 60 }, { bin: 3, n: 20 }, { bin: 10, n: 10 }]);
    expect(s.n).toBe(100);
    expect(s.medianMin).toBe(0);
    expect(s.p10Min).toBe(-5);
    expect(s.p90Min).toBe(3);
    expect(s.early).toBe(0.1);
    expect(s.late).toBe(0.1);
    expect(s.onTime).toBe(0.8);
  });

  it("is safe on empty input", () => {
    expect(summarize([])).toEqual({ n: 0 });
  });
});
