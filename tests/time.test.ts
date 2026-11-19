import { describe, expect, it } from "vitest";
import { istLabel, timeMs, zonedTime } from "@/lib/time";

describe("times from people and Claude", () => {
  it("a time without a zone is India time; with a zone it is kept; nonsense is null", () => {
    expect(zonedTime("2026-11-20T09:00")).toBe("2026-11-20T09:00:00+05:30");
    expect(zonedTime("2026-11-20T09:00:00")).toBe("2026-11-20T09:00:00+05:30");
    expect(zonedTime("2026-11-20 09:00")).toBe("2026-11-20T09:00:00+05:30");
    expect(zonedTime("2026-11-20")).toBe("2026-11-20T00:00:00+05:30");
    expect(zonedTime("2026-11-20T09:00:00Z")).toBe("2026-11-20T09:00:00Z");
    expect(zonedTime("2026-11-20T09:00:00+05:30")).toBe("2026-11-20T09:00:00+05:30");
    expect(zonedTime("tomorrow 9am")).toBeNull();
    expect(zonedTime("")).toBeNull();
    expect(istLabel(zonedTime("2026-11-20T09:00"))).toMatch(/20 Nov 2026, 0?9:00 am IST/);
  });
  it("SQLite's UTC times are read as UTC, not local time", () => {
    expect(timeMs("2026-11-18 14:12:26")).toBe(Date.UTC(2026, 10, 18, 14, 12, 26));
    expect(istLabel("2026-11-18 14:12:26")).toMatch(/18 Nov 2026, 0?7:42 pm IST/);
  });
});
