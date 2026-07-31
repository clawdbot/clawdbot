// Tests heartbeat runner wake dispatch, cooldown bookkeeping, and cleanup.
// Interval cadence is owned by system cron monitor jobs; tests drive the
// scheduled path by poking `requestHeartbeat({source:"interval"})` after
// advancing fake time past the due slot.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  expectRunCallFields,
  getRunCall,
  heartbeatConfig,
  TEST_SCHEDULER_SEED,
  useFakeHeartbeatTime,
  wake,
  type MockRunOnce,
  type RunOnce,
} from "./heartbeat-runner.scheduler.test-support.js";
import { computeNextHeartbeatPhaseDueMs, resolveHeartbeatPhaseMs } from "./heartbeat-schedule.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("startHeartbeatRunner", () => {
  function startDefaultRunner(runOnce: RunOnce) {
    return startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
  }

  it("does not self-fire when cron is disabled", async () => {
    useFakeHeartbeatTime();
    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const disabledCfg = {
      ...heartbeatConfig(),
      cron: { enabled: false },
    } as OpenClawConfig;
    const runner = startHeartbeatRunner({
      cfg: disabledCfg,
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(runOnce).not.toHaveBeenCalled();
    runner.stop();
  });

  it("starts stopped when its owner signal is already aborted", async () => {
    useFakeHeartbeatTime();
    const owner = new AbortController();
    owner.abort();
    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
      abortSignal: owner.signal,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).not.toHaveBeenCalled();

    const drain = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    const disposeDrain = setHeartbeatWakeHandler(drain);
    await vi.advanceTimersByTimeAsync(250);
    expect(drain).toHaveBeenCalledOnce();
    disposeDrain();
    runner.stop();
  });

  it("removes its owner abort listener on manual stop", () => {
    const owner = new AbortController();
    const removeListener = vi.spyOn(owner.signal, "removeEventListener");
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      abortSignal: owner.signal,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    runner.stop();

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("aborts an active wake when the runner stops", async () => {
    useFakeHeartbeatTime();
    let finishWake: (() => void) | undefined;
    const wakeFinished = new Promise<void>((resolve) => {
      finishWake = resolve;
    });
    let wakeSignal: AbortSignal | undefined;
    const runOnce = vi.fn(async () => {
      wakeSignal = getHeartbeatWakeAbortSignal();
      await wakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    const runner = startDefaultRunner(runOnce);
    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(wakeSignal?.aborted).toBe(false);

    runner.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(wakeSignal?.aborted).toBe(true);
    finishWake?.();
    await vi.advanceTimersByTimeAsync(0);

    const drain = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    const disposeDrain = setHeartbeatWakeHandler(drain);
    await vi.advanceTimersByTimeAsync(250);
    expect(drain).toHaveBeenCalledOnce();
    disposeDrain();
  });

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

  function expectAgentCall(params: {
    runSpy: MockRunOnce;
    agentId: string;
    expectedHeartbeatEvery?: string;
    startIndex?: number;
  }) {
    const call = params.runSpy.mock.calls
      .slice(params.startIndex ?? 0)
      .map((entry) => entry[0] as { agentId?: string; heartbeat?: { every?: string } })
      .find((options) => options.agentId === params.agentId);
    if (!call) {
      throw new Error(`Expected heartbeat run call for ${params.agentId}`);
    }
    if (params.expectedHeartbeatEvery) {
      expect(call.heartbeat?.every).toBe(params.expectedHeartbeatEvery);
    }
  }

  afterEach(() => {
    resetConfigRuntimeState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("updates scheduling when config changes without restart", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);
    const firstDueMs = resolveDueFromNow(0, 30 * 60_000, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(runSpy, 0, { agentId: "main", reason: "interval" });

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
    await pokeIntervalWake();

    const reloadedAgentIds = runSpy.mock.calls.slice(1).map((call) => call[0]?.agentId);
    expect(reloadedAgentIds).toContain("main");
    expect(reloadedAgentIds).toContain("ops");
    expectAgentCall({
      runSpy,
      agentId: "main",
      expectedHeartbeatEvery: "10m",
      startIndex: 1,
    });
    expectAgentCall({
      runSpy,
      agentId: "ops",
      expectedHeartbeatEvery: "15m",
      startIndex: 1,
    });

    runner.stop();
  });

  it("uses the persisted monitor cadence for scheduled ticks and later cooldown", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startDefaultRunner(runSpy);
    const monitorAnchorMs = resolveHeartbeatPhaseMs({
      schedulerSeed: TEST_SCHEDULER_SEED,
      agentId: "main",
      intervalMs: 5 * 60_000,
    });
    const monitorDueMs = resolveDueFromNow(0, 5 * 60_000, "main");
    await vi.advanceTimersByTimeAsync(monitorDueMs);

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      scheduledAnchorMs: monitorAnchorMs,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect((getRunCall(runSpy, 0).heartbeat as { every?: string }).every).toBe("300000ms");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    requestHeartbeat(wake("exec-event", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it("keeps persisted monitor cadence authoritative when its tick joins a task turn", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startDefaultRunner(runSpy);
    const monitorAnchorMs = resolveHeartbeatPhaseMs({
      schedulerSeed: TEST_SCHEDULER_SEED,
      agentId: "main",
      intervalMs: 5 * 60_000,
    });

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
      scheduledAnchorMs: monitorAnchorMs,
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(runSpy, 0, {
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });
    expect((getRunCall(runSpy, 0).heartbeat as { every?: string }).every).toBe("300000ms");

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    requestHeartbeat(wake("exec-event", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it("reads the latest runtime config for heartbeat wakes after no-op reload commits", async () => {
    useFakeHeartbeatTime();

    const initialConfig: OpenClawConfig = {
      ...heartbeatConfig(),
      messages: { visibleReplies: "automatic" },
    };
    const nextConfig: OpenClawConfig = {
      ...heartbeatConfig(),
      messages: { visibleReplies: "message_tool" },
    };
    setRuntimeConfigSnapshot(initialConfig, initialConfig);
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: initialConfig,
      readCurrentConfig: getRuntimeConfig,
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    setRuntimeConfigSnapshot(nextConfig, nextConfig);
    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    const options = getRunCall(runSpy, 0);
    expect((options.cfg as OpenClawConfig).messages?.visibleReplies).toBe("message_tool");
    expect((options.heartbeat as { every?: string }).every).toBe("30m");
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
    await pokeIntervalWake();

    const agentIds = runSpy.mock.calls.map((call) => call[0]?.agentId);
    expect(agentIds).toContain("main");
    expect(agentIds).toContain("ops");

    runner.stop();
  });

  it("keeps serving interval wakes after runOnce throws an unhandled error", async () => {
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

    // First interval poke fires and throws inside runOnce.
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // A later poke past the next due slot must still run (handler not dead).
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await pokeIntervalWake();
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

    // Runner B should still serve interval wakes
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    expect(runSpy2).toHaveBeenCalledTimes(1);
    expect(runSpy1).not.toHaveBeenCalled();

    // Double-stop should be safe (idempotent)
    runnerA.stop();

    runnerB.stop();
  });

  it("ignores interval wakes after the runner is stopped", async () => {
    useFakeHeartbeatTime();

    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startDefaultRunner(runSpy);

    runner.stop();

    // After stopping, pokes past the due slot must not reach runOnce.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await pokeIntervalWake();
    expect(runSpy).not.toHaveBeenCalled();

    // Drain the wake queued while no handler was registered so it cannot
    // leak into the next test's freshly registered handler.
    const disposeDrain = setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
    await vi.advanceTimersByTimeAsync(300);
    disposeDrain();
  });

  it("advances cadence after non-retryable disabled skips", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" } as const);

    const intervalMs = 10 * 60_000;
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "10m" } }]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const firstDueMs = resolveDueFromNow(0, intervalMs, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Non-retryable skip advanced nextDueMs to the next slot, so an interval
    // poke shortly after must defer with not-due instead of re-running.
    await vi.advanceTimersByTimeAsync(2_000);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("advances normal cadence after terminal tool failures", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "agent-tool-failure" } as const);

    const intervalMs = 10 * 60_000;
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "10m" } }]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const firstDueMs = resolveDueFromNow(0, intervalMs, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Terminal failure still advances the cadence — a poke inside the new
    // cooldown window must not re-run the failing heartbeat.
    await vi.advanceTimersByTimeAsync(2_000);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    runner.stop();
  });

  it("flood guard defers due interval wakes after repeated runs", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 } as const);

    const intervalMs = 1_000;
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "1s" } }]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    const firstDueMs = resolveDueFromNow(0, intervalMs, "main");

    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs);
      await pokeIntervalWake();
    }
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Five runs inside the flood window: the next due interval poke defers
    // via the flood guard, and the deferral is terminal (no wake-layer retry).
    await vi.advanceTimersByTimeAsync(intervalMs);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(5);

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

    // Poke the first heartbeat at the agent's first slot — returns
    // requests-in-flight, so no bookkeeping is recorded.
    await vi.advanceTimersByTimeAsync(firstDueMs + 1);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    // The wake layer auto-retries the busy interval wake every 1s; the busy
    // skips must not advance nextDueMs, so each retry reaches runOnce until
    // the 6th attempt succeeds.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(runSpy).toHaveBeenCalledTimes(6);
    const scheduledSlotCallsBeforeInterval = callTimes.filter(
      (time) => time >= firstDueMs + intervalMs,
    );
    expect(scheduledSlotCallsBeforeInterval).toStrictEqual([]);

    // The next interval poke at the next scheduled slot should still fire —
    // the retries must not push the phase out by multiple intervals.
    await vi.advanceTimersByTimeAsync(firstDueMs + intervalMs - Date.now() + 1);
    await pokeIntervalWake();
    const scheduledSlotCallsAfterInterval = callTimes.filter(
      (time) => time >= firstDueMs + intervalMs,
    );
    expect(scheduledSlotCallsAfterInterval.length).toBeGreaterThan(0);

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
    expectRunCallFields(runSpy, 1, { reason, sessionKey: "agent:main:main" });
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
    expectRunCallFields(runSpy, 1, {
      reason: "exec-event",
      sessionKey: "agent:main:main",
    });
    await expect(runSpy.mock.results[1]?.value).resolves.toEqual({
      status: "ran",
      durationMs: 1,
    });

    runner.stop();
  });
});
