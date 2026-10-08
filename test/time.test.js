import { describe, it, expect } from "vitest";
import { kyivDay, kyivHour, plannedTs } from "../src/time.js";

describe("Kyiv time", () => {
  it("handles summer (UTC+3) and winter (UTC+2) midnight", () => {
    expect(kyivDay(Date.UTC(2026, 6, 1, 12) / 1000)).toEqual({ day: "2026-07-01", midnight: Date.UTC(2026, 5, 30, 21) / 1000 });
    expect(kyivDay(Date.UTC(2026, 11, 1, 12) / 1000)).toEqual({ day: "2026-12-01", midnight: Date.UTC(2026, 10, 30, 22) / 1000 });
  });

  it("puts 22:30 UTC in the next Kyiv day", () => {
    expect(kyivDay(Date.UTC(2026, 6, 1, 22, 30) / 1000).day).toBe("2026-07-02");
    expect(kyivHour(Date.UTC(2026, 6, 1, 22, 30) / 1000)).toBe(1);
  });

  it("matches a post-midnight trip to the previous service day", () => {
    const obs = Date.UTC(2026, 6, 1, 21, 10) / 1000; // 00:10 Kyiv on 2 July
    const planned = plannedTs(obs, 24 * 3600 + 5 * 60); // "24:05:00" of 1 July
    expect(planned).toBe(Date.UTC(2026, 6, 1, 21, 5) / 1000);
  });

  it("matches a bus waiting before midnight to tomorrow's early trip", () => {
    const obs = Date.UTC(2026, 6, 1, 20, 50) / 1000; // 23:50 Kyiv on 1 July
    expect(plannedTs(obs, 30 * 60)).toBe(Date.UTC(2026, 6, 1, 21, 30) / 1000); // 00:30 on 2 July
  });

  it("matches an ordinary trip to today", () => {
    const obs = Date.UTC(2026, 6, 1, 6, 0) / 1000; // 09:00 Kyiv
    expect(plannedTs(obs, 9 * 3600 + 60)).toBe(Date.UTC(2026, 6, 1, 6, 1) / 1000);
  });
});
