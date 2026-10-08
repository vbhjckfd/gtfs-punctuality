import { describe, it, expect } from "vitest";
import { summarize, routeMode } from "../src/stats.js";

describe("summarize", () => {
  it("computes percentiles and the on-time split from minute bins", () => {
    const s = summarize([{ bin: -5, n: 10 }, { bin: 0, n: 60 }, { bin: 3, n: 20 }, { bin: 10, n: 10 }]);
    expect(s.n).toBe(100);
    expect(s.medianMin).toBe(0);
    expect(s.p10Min).toBe(-5);
    expect(s.p90Min).toBe(3);
    expect(s.early).toBe(0.1);
    expect(s.late).toBe(0.3); // +3 and +10 are both outside ±1 min
    expect(s.onTime).toBe(0.6);
  });

  it("tolerates one minute either way", () => {
    const s = summarize([{ bin: -2, n: 1 }, { bin: -1, n: 1 }, { bin: 0, n: 1 }, { bin: 1, n: 1 }, { bin: 2, n: 1 }]);
    expect(s.early).toBe(0.2);
    expect(s.onTime).toBe(0.6);
    expect(s.late).toBe(0.2);
  });

  it("is safe on empty input", () => {
    expect(summarize([])).toEqual({ n: 0, unmatched: 0, unmatchedShare: 0 });
  });

  it("keeps departures more than 30 min off out of every other figure", () => {
    const s = summarize([{ bin: -45, n: 20 }, { bin: -30, n: 10 }, { bin: 0, n: 60 }, { bin: 31, n: 10 }]);
    expect(s.n).toBe(70);
    expect(s.unmatched).toBe(30);
    expect(s.unmatchedShare).toBe(0.3);
    expect(s.p10Min).toBe(-30); // -30 itself is still a match
    expect(s.early).toBeCloseTo(10 / 70, 4);
  });

  it("reports only the unmatched count when nothing matched", () => {
    expect(summarize([{ bin: 50, n: 4 }])).toEqual({ n: 0, unmatched: 4, unmatchedShare: 1 });
  });
});

describe("routeMode", () => {
  it("tells trolleybuses from buses by prefix", () => {
    expect(routeMode(0, "Т03")).toBe("tram");
    expect(routeMode(3, "Тр30")).toBe("trolleybus");
    expect(routeMode(11, "X")).toBe("trolleybus");
    expect(routeMode(3, "А41")).toBe("bus");
  });
});
