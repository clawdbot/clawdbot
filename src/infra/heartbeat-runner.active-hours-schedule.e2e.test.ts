// Covers heartbeat active-hours scheduling (#75487). Interval cadence is
// owned by system cron monitor jobs; these tests poke the wake queue with
// `source: "interval"` and assert the runner's `nextDueMs` seek defers
// quiet-hours pokes and admits in-window ones.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { computeNextHeartbeatPhaseDueMs, resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("heartbeat scheduler: activeHours-aware scheduling (#75487)", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  const TEST_SCHEDULER_SEED = "heartbeat-ah-schedule-test-seed";

  function useFakeHeartbeatTime(startMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startMs));
  }

  // Stand-in for a system cron monitor tick: the cron job pokes the wake
  // queue; the runner decides via `nextDueMs` whether the agent is due.
  async function pokeIntervalWake() {
    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers quiet-hours pokes and admits the first in-window phase slot", async () => {
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

    // Poke past the raw due slot — still quiet hours, so nextDueMs was
    // seeked into tomorrow's window and the poke must defer.
    await vi.advanceTimersByTimeAsync(rawDueMs - startMs + 1);
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    // Poke inside the next day's window, past the seeked slot (4h spacing
    // puts the first in-window slot no later than 13:00) — must fire.
    const inWindowMs = Date.parse("2026-06-16T16:00:00.000Z");
    await vi.advanceTimersByTimeAsync(inWindowMs - Date.now());
    await pokeIntervalWake();

    expect(runSpy).toHaveBeenCalled();
    const firstCallHourUTC = new Date(
      expectDefined(callTimes[0], "callTimes[0] test invariant"),
    ).getUTCHours();
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
    await pokeIntervalWake();

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

    // Quiet-hours poke shortly after start must defer.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    // Poke inside the next ET window (first in-window slot is no later than
    // 17:00 UTC given 4h spacing from the 13:00 UTC window start).
    const inWindowMs = Date.parse("2026-06-16T17:00:00.000Z");
    await vi.advanceTimersByTimeAsync(inWindowMs - Date.now());
    await pokeIntervalWake();

    expect(runSpy).toHaveBeenCalled();
    const firstCallHourUTC = new Date(
      expectDefined(callTimes[0], "callTimes[0] test invariant"),
    ).getUTCHours();
    expect(firstCallHourUTC).toBeGreaterThanOrEqual(13);
    expect(firstCallHourUTC).toBeLessThan(21);

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

    // Past any 30m slot: the poke reaches runOnce (the runtime guard owns
    // the quiet-hours skip when seek cannot find an active slot).
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Non-retryable skip advanced the cadence — an immediate second poke
    // must defer instead of hot-looping runOnce.
    await vi.advanceTimersByTimeAsync(1_000);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("recomputes schedule when activeHours config changes via hot reload", async () => {
    // Narrow window pushes nextDueMs to tomorrow; widening via updateConfig
    // must recompute from `now` so a poke today is admitted.
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
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    // Widen window — scheduler must recompute, not keep stale tomorrow slot.
    runner.updateConfig(
      heartbeatConfig({
        every: "4h",
        activeHours: { start: "08:00", end: "20:00", timezone: "UTC" },
      }),
    );

    // The recomputed slot lands no later than 19:00 today (4h spacing from
    // 15:00), so a poke this evening must fire today — not tomorrow.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalled();
    expect(new Date(expectDefined(callTimes[0], "callTimes[0] test invariant")).getUTCDate()).toBe(
      15,
    ); // today, not tomorrow

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
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    runner.updateConfig(
      heartbeatConfig({
        every: "4h",
        activeHours,
        userTimezone: "UTC",
      }),
    );

    // With UTC the seed's slot falls inside today's 16:00–17:00 window; a
    // poke at window end must be admitted today. Under the stale ET slot
    // (tomorrow 20:00 UTC) it would still defer.
    const endOfUtcWindow = Date.parse("2026-06-15T17:00:00.000Z");
    await vi.advanceTimersByTimeAsync(endOfUtcWindow - Date.now());
    await pokeIntervalWake();

    expect(runSpy).toHaveBeenCalled();
    const firstCall = new Date(expectDefined(callTimes[0], "callTimes[0] test invariant"));
    expect(firstCall.getUTCDate()).toBe(15);

    runner.stop();
  });

  it("reaches a narrow active window with a sub-minute interval", async () => {
    const startMs = Date.parse("2026-06-15T17:00:00.000Z");
    useFakeHeartbeatTime(startMs);

    const callTimes: number[] = [];
    const runSpy: RunOnce = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig({
        every: "30s",
        activeHours: { start: "09:00", end: "09:01", timezone: "UTC" },
      }),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Quiet-hours poke long before tomorrow's window must defer.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    // 30s spacing puts a slot no later than 09:00:30 inside the one-minute
    // window; a poke there must fire within the window.
    const inWindowMs = Date.parse("2026-06-16T09:00:30.000Z");
    await vi.advanceTimersByTimeAsync(inWindowMs - Date.now());
    await pokeIntervalWake();

    expect(callTimes.length).toBeGreaterThan(0);
    for (const callTime of callTimes) {
      const call = new Date(callTime);
      expect(call.getUTCHours()).toBe(9);
      expect(call.getUTCMinutes()).toBe(0);
    }
    runner.stop();
  });
});
