import { describe, expect, it } from "vitest";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";

describe("resolveGlobalLane", () => {
  it("defaults to main lane when no lane is provided", () => {
    expect(resolveGlobalLane()).toBe(CommandLane.Main);
    for (const lane of ["", "  "]) {
      expect(resolveGlobalLane(lane)).toBe(CommandLane.Main);
    }
  });

  it("maps cron lane to cron-nested lane to prevent deadlocks", () => {
    // When cron jobs trigger nested agent runs, the outer execution holds
    // the cron lane slot. Inner work must use a separate lane to avoid
    // deadlock. See: https://github.com/openclaw/openclaw/issues/44805
    for (const lane of ["cron", "  cron  "]) {
      expect(resolveGlobalLane(lane)).toBe(CommandLane.CronNested);
    }
  });

  it("preserves other lanes as-is", () => {
    for (const [lane, expected] of [
      ["main", CommandLane.Main],
      ["subagent", CommandLane.Subagent],
      ["cron-nested", CommandLane.CronNested],
      ["nested", CommandLane.Nested],
      ["custom-lane", "custom-lane"],
      [" custom ", "custom"],
    ] as const) {
      expect(resolveGlobalLane(lane)).toBe(expected);
    }
  });
});

describe("resolveSessionLane", () => {
  it("defaults to main lane and prefixes with session:", () => {
    for (const lane of ["", "  "]) {
      expect(resolveSessionLane(lane)).toBe("session:main");
    }
  });

  it("adds session: prefix if not present", () => {
    for (const [lane, expected] of [
      ["abc123", "session:abc123"],
      [" xyz ", "session:xyz"],
    ] as const) {
      expect(resolveSessionLane(lane)).toBe(expected);
    }
  });

  it("preserves existing session: prefix", () => {
    for (const lane of ["session:abc", "session:main"]) {
      expect(resolveSessionLane(lane)).toBe(lane);
    }
  });
});
