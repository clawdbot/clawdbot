import { describe, expect, it } from "vitest";
import {
  computeNextHeartbeatPhaseDueMs,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs,
} from "./heartbeat-schedule.js";

describe("heartbeat schedule helpers", () => {
  it("derives a stable per-agent phase inside the interval", () => {
    const first = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });
    const second = resolveHeartbeatPhaseMs({
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    });

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(60 * 60_000);
  });

  it("returns the next future slot for the agent phase", () => {
    const intervalMs = 60 * 60_000;
    const phaseMs = 15 * 60_000;

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:10:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T10:15:00.000Z"));

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Date.parse("2026-01-01T10:15:00.000Z"),
        intervalMs,
        phaseMs,
      }),
    ).toBe(Date.parse("2026-01-01T11:15:00.000Z"));
  });

  it("preserves an unchanged future schedule across config reloads", () => {
    const nextDueMs = Date.parse("2026-01-01T11:15:00.000Z");

    expect(
      resolveNextHeartbeatDueMs({
        nowMs: Date.parse("2026-01-01T10:20:00.000Z"),
        intervalMs: 60 * 60_000,
        phaseMs: 15 * 60_000,
        prev: {
          intervalMs: 60 * 60_000,
          phaseMs: 15 * 60_000,
          nextDueMs,
        },
      }),
    ).toBe(nextDueMs);
  });
});

describe("seekNextActivePhaseDueMs", () => {
  const HOUR = 60 * 60_000;

  it("returns startMs immediately when no isActive predicate is provided", () => {
    const startMs = Date.parse("2026-01-01T03:00:00.000Z");
    expect(
      seekNextActivePhaseDueMs({
        startMs,
        intervalMs: 4 * HOUR,
        phaseMs: 0,
      }),
    ).toBe(startMs);
  });

  it("returns startMs when the first slot is already within active hours", () => {
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    expect(
      seekNextActivePhaseDueMs({
        startMs,
        intervalMs: 4 * HOUR,
        phaseMs: 0,
        isActive: () => true,
      }),
    ).toBe(startMs);
  });

  it("skips quiet-hours slots and returns the first in-window slot", () => {
    // 08:00–17:00 UTC, 4h interval, start at 19:00 (quiet).
    const startMs = Date.parse("2026-01-01T19:00:00.000Z");
    const intervalMs = 4 * HOUR;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 8 && hour < 17;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-02T11:00:00.000Z"));
  });

  it("handles overnight active windows correctly", () => {
    // 22:00–06:00 UTC (overnight), 4h interval, start at 10:00 (quiet).
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    const intervalMs = 4 * HOUR;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 22 || hour < 6;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-01T22:00:00.000Z"));
  });

  it("falls back to startMs when no slot is active within the seek horizon", () => {
    const startMs = Date.parse("2026-01-01T10:00:00.000Z");
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: 4 * HOUR,
      phaseMs: 0,
      isActive: () => false,
    });

    expect(result).toBe(startMs);
  });

  it("seeks across timezone-aware active hours using isWithinActiveHours semantics", () => {
    // Asia/Shanghai (UTC+8): active 08:00–23:00 local.
    const startMs = Date.parse("2026-01-01T15:21:00.000Z");
    const intervalMs = 4 * HOUR;
    const shanghaiOffsetMs = 8 * HOUR;

    const isActive = (ms: number) => {
      const shanghaiMs = ms + shanghaiOffsetMs;
      const shanghaiHour = new Date(shanghaiMs).getUTCHours();
      return shanghaiHour >= 8 && shanghaiHour < 23;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-02T03:21:00.000Z"));
  });

  it("handles very short intervals efficiently", () => {
    // 30m interval, 09:00–17:00. Start at 17:00 (quiet) → 09:00 next day.
    const startMs = Date.parse("2026-01-01T17:00:00.000Z");
    const intervalMs = 30 * 60_000;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 9 && hour < 17;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-02T09:00:00.000Z"));
  });

  it("caps iterations for pathological sub-second intervals", () => {
    const startMs = Date.parse("2026-01-01T12:00:00.000Z");
    const t0 = performance.now();
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: 1, // 1ms — pathological
      phaseMs: 0,
      isActive: () => false,
    });
    const elapsedMs = performance.now() - t0;

    expect(result).toBe(startMs);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("handles intervalMs larger than the seek horizon", () => {
    const startMs = Date.parse("2026-01-01T03:00:00.000Z");
    const eightDays = 8 * 24 * HOUR;
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: eightDays,
      phaseMs: 0,
      isActive: (ms) => {
        const hour = new Date(ms).getUTCHours();
        return hour >= 9 && hour < 17;
      },
    });

    expect(result).toBe(startMs);
  });

  it("returns startMs when intervalMs larger than horizon and startMs is active", () => {
    const startMs = Date.parse("2026-01-01T12:00:00.000Z"); // 12:00 — active
    const eightDays = 8 * 24 * HOUR;
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: eightDays,
      phaseMs: 0,
      isActive: (ms) => {
        const hour = new Date(ms).getUTCHours();
        return hour >= 9 && hour < 17;
      },
    });

    expect(result).toBe(startMs);
  });
});
