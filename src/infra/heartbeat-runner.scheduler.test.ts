import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { computeNextHeartbeatPhaseDueMs, resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type RetryableHeartbeatBusySkipReason,
  requestHeartbeat,
  resetHeartbeatWakeStateForTests,
} from "./heartbeat-wake.js";

describe("startHeartbeatRunner", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  const TEST_SCHEDULER_SEED = "heartbeat-runner-test-seed";

  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  }

  function startDefaultRunner(runOnce: RunOnce) {
    return startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
  }

  function heartbeatConfig(
    list?: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>,
  ): OpenClawConfig {
    return {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        ...(list ? { list } : {}),
      },
    } as OpenClawConfig;
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

  function createRetryableBusyRunSpy(reason: RetryableHeartbeatBusySkipReason, skipCount: number) {
    let callCount = 0;
    return vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= skipCount) {
        return { status: "skipped", reason } as const;
      }
      return { status: "ran", durationMs: 1 } as const;
    });
  }

  function wake(
    reason: string,
    opts: Partial<Parameters<typeof requestHeartbeat>[0]> = {},
  ): Parameters<typeof requestHeartbeat>[0] {
    const source =
      opts.source ??
      (reason === "interval"
        ? "interval"
        : reason === "manual"
          ? "manual"
          : reason === "retry"
            ? "retry"
            : reason === "exec-event"
              ? "exec-event"
              : reason === "background-task"
                ? "background-task"
                : reason === "background-task-blocked"
                  ? "background-task-blocked"
                  : reason.startsWith("cron:")
                    ? "cron"
                    : reason.startsWith("hook:")
                      ? "hook"
                      : "other");
    const intent =
      opts.intent ??
      (reason === "interval"
        ? "scheduled"
        : reason === "manual"
          ? "manual"
          : reason === "wake" ||
              reason === "background-task" ||
              reason === "background-task-blocked"
            ? "immediate"
            : "event");
    return { source, intent, reason, ...opts };
  }

  async function expectWakeDispatch(params: {
    cfg: OpenClawConfig;
    runSpy: RunOnce;
    wake: Parameters<typeof requestHeartbeat>[0];
    expectedCall: Record<string, unknown>;
  }) {
    const runner = startHeartbeatRunner({
      cfg: params.cfg,
      runOnce: params.runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat(params.wake);
    await vi.advanceTimersByTimeAsync(1);

    expect(params.runSpy).toHaveBeenCalledTimes(1);
    expect(params.runSpy).toHaveBeenCalledWith(expect.objectContaining(params.expectedCall));

    return runner;
  }

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates scheduling when config changes without restart", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: "main", reason: "interval" }),
    );

    runner.updateConfig({
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [
          { id: "main", heartbeat: { every: "10m" } },
          { id: "ops", heartbeat: { every: "15m" } },
        ],
      },
    } as OpenClawConfig);

    const nowAfterReload = Date.now();
    const nextMainDueMs = resolveDueFromNow(nowAfterReload, 10 * 60_000, "main");
    const nextOpsDueMs = resolveDueFromNow(nowAfterReload, 15 * 60_000, "ops");
    const finalDueMs = Math.max(nextMainDueMs, nextOpsDueMs);

    await vi.advanceTimersByTimeAsync(finalDueMs - Date.now() + 1);

    expect(runSpy.mock.calls.slice(1).map((call) => call[0]?.agentId)).toEqual(
      expect.arrayContaining(["main", "ops"]),
    );
    expect(
      runSpy.mock.calls.some(
        (call) => call[0]?.agentId === "main" && call[0]?.heartbeat?.every === "10m",
      ),
    ).toBe(true);
    expect(
      runSpy.mock.calls.some(
        (call) => call[0]?.agentId === "ops" && call[0]?.heartbeat?.every === "15m",
      ),
    ).toBe(true);

    runner.stop();
  });

  it("schedules every configured agent when only global heartbeat defaults exist", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main" }, { id: "ops" }]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const mainDueMs = resolveDueFromNow(0, 30 * 60_000, "main");
    const opsDueMs = resolveDueFromNow(0, 30 * 60_000, "ops");

    await vi.advanceTimersByTimeAsync(Math.max(mainDueMs, opsDueMs) + 1);

    expect(runSpy.mock.calls.map((call) => call[0]?.agentId)).toEqual(
      expect.arrayContaining(["main", "ops"]),
    );

    runner.stop();
  });

  it("continues scheduling after runOnce throws an unhandled error", async () => {
    useFakeHeartbeatTime();

    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call throws (simulates crash during session compaction)
        throw new Error("session compaction error");
      }
      return { status: "ran", durationMs: 1 };
    });

    const runner = startDefaultRunner(runSpy);
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    // First heartbeat fires and throws
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Second heartbeat should still fire (scheduler must not be dead)
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("cleanup is idempotent and does not clear a newer runner's handler", async () => {
    useFakeHeartbeatTime();

    const runSpy1 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runSpy2 = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const cfg = {
      agents: { defaults: { heartbeat: { every: "30m" } } },
    } as OpenClawConfig;
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    // Start runner A
    const runnerA = startHeartbeatRunner({
      cfg,
      runOnce: runSpy1,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Start runner B (simulates lifecycle reload)
    const runnerB = startHeartbeatRunner({
      cfg,
      runOnce: runSpy2,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Stop runner A (stale cleanup) — should NOT kill runner B's handler
    runnerA.stop();

    // Runner B should still fire
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    expect(runSpy2).toHaveBeenCalledTimes(1);
    expect(runSpy1).not.toHaveBeenCalled();

    // Double-stop should be safe (idempotent)
    runnerA.stop();

    runnerB.stop();
  });

  it("run() returns skipped when runner is stopped", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    runner.stop();

    // After stopping, no heartbeats should fire
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("reschedules timer when runOnce returns requests-in-flight", async () => {
    useFakeHeartbeatTime();

    const runSpy = createRetryableBusyRunSpy(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, 1);

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    // First heartbeat returns requests-in-flight
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // The wake layer retries after DEFAULT_RETRY_MS (1 s).  No scheduleNext()
    // is called inside runOnce, so we must wait for the full cooldown.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("reschedules timer when runOnce returns cron-in-progress", async () => {
    useFakeHeartbeatTime();

    const runSpy = createRetryableBusyRunSpy(HEARTBEAT_SKIP_CRON_IN_PROGRESS, 1);

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSpy).toHaveBeenCalledTimes(2);

    runner.stop();
  });

  it("does not push nextDueMs forward on repeated requests-in-flight skips", async () => {
    useFakeHeartbeatTime();

    // Simulate a long-running heartbeat: the first 5 calls return
    // requests-in-flight (retries from the wake layer), then the 6th succeeds.
    const callTimes: number[] = [];
    let callCount = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      callCount++;
      if (callCount <= 5) {
        return { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
      }
      return { status: "ran", durationMs: 1 } as const;
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const intervalMs = 30 * 60_000;
    const firstDueMs = resolveDueFromNow(0, intervalMs, "main");

    // Trigger the first heartbeat at the agent's first slot — returns requests-in-flight.
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Simulate 4 more retries at short intervals (wake layer retries).
    for (let i = 0; i < 4; i++) {
      requestHeartbeat(wake("retry", { coalesceMs: 0 }));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(callTimes.some((time) => time >= firstDueMs + intervalMs)).toBe(false);

    // The next interval tick at the next scheduled slot should still fire —
    // the retries must not push the phase out by multiple intervals.
    await vi.advanceTimersByTimeAsync(firstDueMs + intervalMs - Date.now() + 1);
    expect(callTimes.some((time) => time >= firstDueMs + intervalMs)).toBe(true);

    runner.stop();
  });

  it("routes targeted wake requests to the requested agent/session", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          { id: "main", heartbeat: { every: "30m" } },
          { id: "ops", heartbeat: { every: "15m" } },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        source: "cron",
        intent: "event",
        reason: "cron:job-123",
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
      },
    });

    runner.stop();
  });

  it("routes targeted wake requests to agents enabled by global defaults", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: heartbeatConfig([{ id: "main" }, { id: "ops" }]),
      runSpy,
      wake: {
        source: "cron",
        intent: "event",
        reason: "cron:job-123",
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
      },
    });

    runner.stop();
  });

  it("merges targeted wake heartbeat overrides onto the agent heartbeat config", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          {
            id: "ops",
            heartbeat: {
              every: "15m",
              prompt: "Ops prompt",
              directPolicy: "block",
              target: "discord:channel:ops",
            },
          },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        source: "cron",
        intent: "event",
        reason: "cron:job-123",
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: { target: "last" },
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: {
          every: "15m",
          prompt: "Ops prompt",
          directPolicy: "block",
          target: "last",
        },
      },
    });

    runner.stop();
  });

  it("clamps oversized scheduler delays so heartbeats do not fire in a tight loop (#71414)", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    // 365d resolves to ~31_536_000_000 ms, well past Node setTimeout's
    // 2_147_483_647 ms cap. Without clamping, setTimeout would fire after
    // 1ms and re-arm in a tight loop, exhausting the runner.
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "365d" } }]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    // Advance well past the broken 1ms re-arm but well under the clamped cap
    // (~24.85d). If the bug is present, runSpy gets called many times.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });

  it("does not fan out to unrelated agents for session-scoped exec wakes", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          { id: "main", heartbeat: { every: "30m" } },
          { id: "finance", heartbeat: { every: "30m" } },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "main",
        reason: "exec-event",
        sessionKey: "agent:main:main",
      },
    });
    expect(runSpy.mock.calls.some((call) => call[0]?.agentId === "finance")).toBe(false);

    runner.stop();
  });

  // Regression for runaway heartbeat loop: backgrounded `process.start` exits
  // call `requestHeartbeat({reason: "exec-event"})` from
  // `bash-tools.exec-runtime.ts:347` (`maybeNotifyOnExit`). If a heartbeat run
  // uses backgrounded tools (response-tracker sync, conversation monitors,
  // etc.), each background process exit triggers another heartbeat run because
  // the dispatcher (`heartbeat-runner.ts:1805`) only enforces `nextDueMs` when
  // `reason === "interval"`, and the targeted branch has no cooldown gate at
  // all. Observed in production: heartbeat configured `every: 30m` fires every
  // ~10s, pegging the gateway event loop with eventLoopDelayMaxMs >6s spikes.
  it("does not bypass interval cooldown for repeated exec-event wakes within nextDueMs", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // First exec-event wake: agent just woke from a backgrounded tool exit.
    // This one legitimately fires the run.
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Simulate the runaway: 4 more exec-event wakes from backgrounded process
    // exits, fired well within the configured 30m interval. These should be
    // debounced by the cooldown — the agent just ran, nothing has changed.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000); // 10s between background exits
      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
    }

    // Total elapsed: ~40s. Configured `every` is 30m. Subsequent exec-events
    // should NOT trigger fresh runs within the cooldown window.
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("preserves immediate delivery for repeated bare wake reasons", async () => {
    // 'wake' is the immediate-path reason from `openclaw system event --mode now`
    // and must NOT be deferred. Verify the runner allows multiple back-to-back
    // wake requests through (subject only to the flood guard backstop).
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    // Three 'wake' requests with 200ms between them — none should be deferred.
    for (let i = 0; i < 3; i++) {
      requestHeartbeat({
        source: "manual",
        intent: "immediate",
        reason: "wake",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(runSpy).toHaveBeenCalledTimes(3);
    runner.stop();
  });

  it("preserves immediate delivery for repeated background-task wakes", async () => {
    // Task-registry terminal updates wake the heartbeat with reason
    // 'background-task'. Documented as immediate so users don't wait for the
    // next scheduled tick to see task completion notifications.
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    for (let i = 0; i < 3; i++) {
      requestHeartbeat({
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(runSpy).toHaveBeenCalledTimes(3);
    runner.stop();
  });

  it("preserves immediate delivery for blocked background-task follow-ups", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    requestHeartbeat({
      source: "background-task-blocked",
      intent: "immediate",
      reason: "background-task-blocked",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        reason: "background-task-blocked",
        sessionKey: "agent:main:main",
      }),
    );
    runner.stop();
  });

  it.each([
    { reason: "hook:wake", label: "hook wake-now" },
    { reason: "hook:job-123", label: "hook agent wake-now announcement" },
    { reason: "cron:job-123", label: "cron wake-now" },
  ])("preserves immediate delivery for $label after a recent run", async ({ reason }) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    requestHeartbeat({
      source: reason.startsWith("cron:") ? "cron" : "hook",
      intent: "immediate",
      reason,
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ reason, sessionKey: "agent:main:main" }),
    );
    runner.stop();
  });

  it("retryable busy skip does not poison the cooldown for the next retry", async () => {
    // Reproduces P2 finding from #75439 review: if a targeted exec-event wake
    // hits requests-in-flight on its first attempt, the wake layer retries the
    // same reason. The cooldown must NOT have been advanced by the busy attempt
    // — otherwise the retry would falsely defer with `not-due`/`min-spacing`.
    useFakeHeartbeatTime();
    let attempt = 0;
    const runSpy = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT } as const;
      }
      return { status: "ran", durationMs: 1 } as const;
    });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Wake layer retries via DEFAULT_RETRY_MS (1s). Advance past it.
    await vi.advanceTimersByTimeAsync(1500);

    // The retry must NOT be deferred to `not-due` or `min-spacing`. Since the
    // first attempt was a retryable busy skip, the cooldown bookkeeping was
    // never recorded — so the retry should reach runOnce normally.
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ reason: "exec-event", sessionKey: "agent:main:main" }),
    );
    await expect(runSpy.mock.results[1]?.value).resolves.toEqual({
      status: "ran",
      durationMs: 1,
    });

    runner.stop();
  });
});
