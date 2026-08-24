// Covers cron-style current-time formatting and invalid Date fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCronStyleCurrentTimeLine, resolveCronStyleNow } from "./current-time.js";

describe("resolveCronStyleNow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when nowMs is outside Date range", () => {
    // Invalid scheduler timestamps should fall back to wall-clock time so cron
    // prompts still get a usable reference date.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC", timeFormat: "24" } } },
      8_640_000_000_000_001,
    );

    expect(result.formattedTime).toBe("Saturday, May 30th, 2026 - 12:00");
    expect(result.timeLine).toContain("Reference UTC: 2026-05-30 12:00 UTC");
  });

  it("falls back to epoch when both nowMs and Date.now are outside Date range", () => {
    // If both inputs are invalid, epoch is the deterministic last resort.
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    const result = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC", timeFormat: "24" } } },
      8_640_000_000_000_001,
    );

    expect(result.timeLine).toContain("Reference UTC: 1970-01-01 00:00 UTC");
  });
});

const CFG = {
  agents: {
    defaults: {
      userTimezone: "UTC",
    },
  },
};

describe("appendCronStyleCurrentTimeLine", () => {
  it("returns the empty input unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", CFG, Date.now())).toBe("");
  });

  it("appends a Current time line when none is present", () => {
    const out = appendCronStyleCurrentTimeLine(
      "Heartbeat tick",
      CFG,
      Date.parse("2026-04-30T10:00:00Z"),
    );
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Reference UTC: 2026-04-30 10:00 UTC/);
  });

  it("refreshes an existing Current time line on subsequent calls (#44993)", () => {
    const oldNow = Date.parse("2026-04-30T08:00:00Z");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const firstPass = appendCronStyleCurrentTimeLine("Heartbeat tick", CFG, oldNow);
    expect(firstPass).toMatch(/Reference UTC: 2026-04-30 08:00 UTC/);

    const secondPass = appendCronStyleCurrentTimeLine(firstPass, CFG, newNow);
    expect(secondPass).toContain("Heartbeat tick");
    expect(secondPass).toMatch(/Reference UTC: 2026-04-30 10:00 UTC/);
    expect(secondPass).not.toMatch(/Reference UTC: 2026-04-30 08:00 UTC/);
    expect(secondPass.match(/Current time:/g)?.length).toBe(1);
  });

  it("collapses multiple Current time blocks into a single fresh entry", () => {
    const stale = [
      "Heartbeat tick",
      "Current time: Wednesday, January 1st, 2025 - 12:00 AM (UTC)\nReference UTC: 2025-01-01 00:00 UTC",
      "Current time: Thursday, January 2nd, 2025 - 12:00 AM (UTC)\nReference UTC: 2025-01-02 00:00 UTC",
    ].join("\n");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(stale, CFG, newNow);
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Reference UTC: 2026-04-30 10:00 UTC/);
    expect(out).not.toMatch(/Reference UTC: 2025-01-01 00:00 UTC/);
    expect(out).not.toMatch(/Reference UTC: 2025-01-02 00:00 UTC/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
  });

  it("matches helper blocks with natural-language formattedTime (#44993 codex P1)", () => {
    const helperShape =
      "Heartbeat tick\nCurrent time: Thursday, April 30th, 2026 - 10:00 AM (Asia/Seoul)\nReference UTC: 2026-04-30 01:00 UTC";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(helperShape, CFG, newNow);
    expect(out).not.toMatch(/Asia\/Seoul/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
    expect(out).toMatch(/Reference UTC: 2026-04-30 10:00 UTC/);
  });

  it("preserves user-authored content that starts with 'Current time:'", () => {
    const userContent = "Reminder from cron:\nCurrent time: please check the dashboard before EOD";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(userContent, CFG, newNow);
    expect(out).toContain("Reminder from cron:");
    expect(out).toContain("Current time: please check the dashboard before EOD");
    expect(out).toMatch(/Current time: .+? \(UTC\)\nReference UTC: 2026-04-30 10:00 UTC/);
    expect(out.match(/Current time:/g)?.length).toBe(2);
  });
});
