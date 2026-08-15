// Covers deterministic heartbeat schedule phase calculation.
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

  it("falls back to finite schedule values for non-finite numeric inputs", () => {
    expect(
      resolveHeartbeatPhaseMs({
        schedulerSeed: "device-a",
        agentId: "main",
        intervalMs: Number.NaN,
      }),
    ).toBe(0);

    expect(
      computeNextHeartbeatPhaseDueMs({
        nowMs: Number.NaN,
        intervalMs: Number.NaN,
        phaseMs: Number.NaN,
      }),
    ).toBe(1);

    expect(
      resolveNextHeartbeatDueMs({
        nowMs: 10,
        intervalMs: Number.NaN,
        phaseMs: Number.NaN,
        prev: {
          intervalMs: 1,
          phaseMs: 0,
          nextDueMs: 20,
        },
      }),
    ).toBe(20);
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

  it("finds the next active slot for 30s intervals", () => {
    const startMs = Date.parse("2026-01-01T17:00:00.000Z");
    const intervalMs = 30_000;
    const isActive = (ms: number) => {
      const hour = new Date(ms).getUTCHours();
      return hour >= 9 && hour < 17;
    };

    const t0 = performance.now();
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });
    const elapsedMs = performance.now() - t0;

    expect(result).toBe(Date.parse("2026-01-02T09:00:00.000Z"));
    expect(elapsedMs).toBeLessThan(100);
    // Phase-aligned: reachable by whole 30s steps
    const steps = (result - startMs) / intervalMs;
    expect(Number.isInteger(steps)).toBe(true);
  });

  it("does not skip phase slots inside narrow active windows (59s / 1min window)", () => {
    // With 59s interval and a 1-minute active window at 09:00-09:01,
    // the first phase-aligned slot inside the window is 09:00:43.
    // Batched stepping (≥118s) would skip from 08:59:44 to 09:01:42,
    // missing 09:00:43 entirely.
    const startMs = Date.parse("2026-01-01T17:00:00.000Z");
    const intervalMs = 59_000;
    const isActive = (ms: number) => {
      const d = new Date(ms);
      return d.getUTCHours() === 9 && d.getUTCMinutes() === 0;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    expect(result).toBe(Date.parse("2026-01-02T09:00:43.000Z"));
    // Phase-aligned
    const steps = (result - startMs) / intervalMs;
    expect(Number.isInteger(steps)).toBe(true);
    expect(steps).toBe(977);
  });

  it("bounds a 1ms never-active scan at 20,160 forward probes", () => {
    const startMs = Date.parse("2026-01-01T12:00:00.000Z");
    let predicateCalls = 0;
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: 1,
      phaseMs: 0,
      isActive: () => {
        predicateCalls += 1;
        return false;
      },
    });

    expect(result).toBe(startMs);
    expect(predicateCalls).toBe(20_160);
  });

  it("returns startMs directly when already active for sub-second intervals", () => {
    // startMs at 16:59:59.500 is already active, so no batch recovery is needed.
    const startMs = Date.parse("2026-01-01T16:59:59.500Z");
    const intervalMs = 500;
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

    // startMs itself is active → return it directly (no backward walk)
    expect(result).toBe(startMs);
    const steps = (result - startMs) / intervalMs;
    expect(Number.isInteger(steps)).toBe(true);
  });

  it("finds the earliest sub-second slot with bounded transition probes", () => {
    // 500ms interval batches at 30s. Start at 08:59:59.500 (inactive), then
    // binary-search the sampled transition to the first active phase slot.
    const startMs = Date.parse("2026-01-01T08:59:59.500Z");
    const intervalMs = 500;
    let predicateCalls = 0;
    const isActive = (ms: number) => {
      predicateCalls += 1;
      const hour = new Date(ms).getUTCHours();
      return hour >= 9 && hour < 17;
    };

    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs,
      phaseMs: 0,
      isActive,
    });

    // The first active phase slot is the first phase candidate >= 09:00
    // 09:00:00.000 - 08:59:59.500 = 500ms = 1 * intervalMs
    expect(result).toBe(Date.parse("2026-01-01T09:00:00.000Z"));
    const steps = (result - startMs) / intervalMs;
    expect(Number.isInteger(steps)).toBe(true);
    expect(steps).toBe(1);
    expect(predicateCalls).toBeLessThanOrEqual(8);
  });

  it("falls back to startMs after 7-day horizon for intervals without active slot", () => {
    const startMs = Date.parse("2026-01-01T12:00:00.000Z");
    let predicateCalls = 0;
    const result = seekNextActivePhaseDueMs({
      startMs,
      intervalMs: HOUR, // 1h interval — only 168 checks in the 7-day horizon
      phaseMs: 0,
      isActive: () => {
        predicateCalls += 1;
        return false;
      },
    });

    expect(result).toBe(startMs);
    expect(predicateCalls).toBe(168);
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
