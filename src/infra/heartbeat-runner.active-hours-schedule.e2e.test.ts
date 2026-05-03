import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { computeNextHeartbeatPhaseDueMs, resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

/** Verifies that the scheduler seeks to in-window phase slots (#75487). */
describe("heartbeat scheduler: activeHours-aware scheduling (#75487)", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  const TEST_SCHEDULER_SEED = "heartbeat-ah-schedule-test-seed";

  function useFakeHeartbeatTime(startMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startMs));
  }

  function heartbeatConfig(overrides?: {
    every?: string;
    activeHours?: { start: string; end: string; timezone?: string };
    userTimezone?: string;
  }): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: {
            every: overrides?.every ?? "4h",
            ...(overrides?.activeHours ? { activeHours: overrides.activeHours } : {}),
          },
          ...(overrides?.userTimezone ? { userTimezone: overrides.userTimezone } : {}),
        },
      },
    };
  }

  function resolveDueFromNow(nowMs: number, intervalMs: number, agentId: string) {
    return computeNextHeartbeatPhaseDueMs({
      nowMs,
      intervalMs,
      phaseMs: resolveHeartbeatPhaseMs({
        schedulerSeed: TEST_SCHEDULER_SEED,
        agentId,
        intervalMs,
      }),
    });
  }

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips quiet-hours slots and fires at the first in-window phase slot", async () => {
    // 09:00–17:00 UTC, 4h interval. Start at 16:30 — raw due is after 17:00.
    const startMs = Date.parse("2026-06-15T16:30:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    const rawDueMs = resolveDueFromNow(startMs, intervalMs, "main");

    // Advance past the raw due — should NOT fire (quiet hours).
    await vi.advanceTimersByTimeAsync(rawDueMs - startMs + 1);

    // Advance to end of next day's window — should fire within 09:00–17:00.
    const safeEndOfWindow = Date.parse("2026-06-16T17:00:00.000Z");
    await vi.advanceTimersByTimeAsync(safeEndOfWindow - Date.now());

    expect(runSpy).toHaveBeenCalled();
    const firstCallHourUTC = new Date(callTimes[0]).getUTCHours();
    expect(firstCallHourUTC).toBeGreaterThanOrEqual(9);
    expect(firstCallHourUTC).toBeLessThan(17);

    runner.stop();
  });

  it("fires immediately when the first phase slot is already within active hours", async () => {
    const startMs = Date.parse("2026-06-15T10:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const intervalMs = 4 * 60 * 60_000;
    const runSpy: RunOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "08:00", end: "20:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    const rawDueMs = resolveDueFromNow(startMs, intervalMs, "main");
    await vi.advanceTimersByTimeAsync(rawDueMs - startMs + 1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it("seeks forward correctly with a non-UTC timezone (e.g. America/New_York)", async () => {
    // 09:00–17:00 ET (EDT = UTC-4 in June) → 13:00–21:00 UTC.
    // Start at 21:30 UTC (17:30 ET = outside window).
    const startMs = Date.parse("2026-06-15T21:30:00.000Z");
    useFakeHeartbeatTime(startMs);

    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "America/New_York" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);

    expect(runSpy).toHaveBeenCalled();
    const firstCallHourUTC = new Date(callTimes[0]).getUTCHours();
    expect(firstCallHourUTC).toBeGreaterThanOrEqual(13);
    expect(firstCallHourUTC).toBeLessThan(21);

    runner.stop();
  });

  it("advances to in-window slot after a quiet-hours skip during interval runs", async () => {
    // 09:00–17:00 UTC, 4h interval. Verify ALL fires over 48h stay in-window.
    const startMs = Date.parse("2026-06-15T09:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);

    expect(callTimes.length).toBeGreaterThan(0);
    for (const t of callTimes) {
      const hour = new Date(t).getUTCHours();
      expect(
        hour,
        `fire at ${new Date(t).toISOString()} is outside active window`,
      ).toBeGreaterThanOrEqual(9);
      expect(hour, `fire at ${new Date(t).toISOString()} is outside active window`).toBeLessThan(
        17,
      );
    }

    runner.stop();
  });

  it("does not loop indefinitely when activeHours window is zero-width", async () => {
    // start === end → never-active; seek falls back, runtime guard skips.
    const startMs = Date.parse("2026-06-15T10:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const runSpy: RunOnce = vi.fn().mockResolvedValue({ status: "skipped", reason: "quiet-hours" });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "30m",
        activeHours: { start: "12:00", end: "12:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(runSpy).toHaveBeenCalled();
    runner.stop();
  });

  it("recomputes schedule when activeHours config changes via hot reload", async () => {
    // Narrow window pushes nextDueMs to tomorrow; widening via updateConfig
    // must recompute from `now` so the timer fires today.
    const startMs = Date.parse("2026-06-15T14:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours: { start: "09:00", end: "10:00", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();

    // Widen window — scheduler must recompute, not keep stale tomorrow slot.
    runner.updateConfig(
      heartbeatConfig({
        every: "4h",
        activeHours: { start: "08:00", end: "20:00", timezone: "UTC" },
      }),
    );

    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(runSpy).toHaveBeenCalled();
    const firstCallHour = new Date(callTimes[0]).getUTCHours();
    expect(firstCallHour).toBeGreaterThanOrEqual(8);
    expect(firstCallHour).toBeLessThan(20);
    expect(new Date(callTimes[0]).getUTCDate()).toBe(15); // today, not tomorrow

    runner.stop();
  });

  it("recomputes schedule when activeHours effective timezone changes via hot reload", async () => {
    const startMs = Date.parse("2026-06-15T14:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    const activeHours = { start: "16:00", end: "17:00" };
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "4h",
        activeHours,
        userTimezone: "America/New_York",
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();

    runner.updateConfig(
      heartbeatConfig({
        every: "4h",
        activeHours,
        userTimezone: "UTC",
      }),
    );

    const endOfUtcWindow = Date.parse("2026-06-15T17:00:00.000Z");
    await vi.advanceTimersByTimeAsync(endOfUtcWindow - Date.now());

    expect(runSpy).toHaveBeenCalled();
    const firstCall = new Date(callTimes[0]);
    expect(firstCall.getUTCHours()).toBe(16);
    expect(firstCall.getUTCDate()).toBe(15);

    runner.stop();
  });
});
