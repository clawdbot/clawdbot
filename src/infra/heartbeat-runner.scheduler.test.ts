// Tests heartbeat runner wake dispatch, cooldown bookkeeping, and cleanup.
// Interval cadence is owned by persisted, per-agent cron monitor jobs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_PREEMPTED,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("startHeartbeatRunner", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  type MockRunOnce = RunOnce & { mock: { calls: unknown[][] } };
  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  }

  function startDefaultRunner(runOnce: RunOnce) {
    return startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce,
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

  async function pokeIntervalWake(agentId = "main", intervalMs = 30 * 60_000) {
    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId,
      scheduledEveryMs: intervalMs,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
  }

  function getRunCall(runSpy: MockRunOnce, callIndex: number) {
    const call = runSpy.mock.calls[callIndex];
    if (!call) {
      throw new Error(`Expected heartbeat run call ${callIndex}`);
    }
    const options = call[0];
    if (!options || typeof options !== "object") {
      throw new Error(`expected heartbeat run options ${callIndex}`);
    }
    return options as Record<string, unknown>;
  }

  function expectRunCallFields(
    runSpy: MockRunOnce,
    callIndex: number,
    expected: Record<string, unknown>,
  ) {
    const options = getRunCall(runSpy, callIndex);
    for (const [key, value] of Object.entries(expected)) {
      expect(options[key]).toEqual(value);
    }
    return options;
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
    runSpy: MockRunOnce;
    wake: Parameters<typeof requestHeartbeat>[0];
    expectedCall: Record<string, unknown>;
  }) {
    const runner = startHeartbeatRunner({
      cfg: params.cfg,
      runOnce: params.runSpy,
    });

    requestHeartbeat(params.wake);
    await vi.advanceTimersByTimeAsync(1);

    expect(params.runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(params.runSpy, 0, params.expectedCall);

    return runner;
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
    await vi.advanceTimersByTimeAsync(30 * 60_000);
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

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await pokeIntervalWake("main", 10 * 60_000);
    await pokeIntervalWake("ops", 15 * 60_000);

    const reloadedAgentIds = runSpy.mock.calls.slice(1).map((call) => call[0]?.agentId);
    expect(reloadedAgentIds).toContain("main");
    expect(reloadedAgentIds).toContain("ops");
    expectAgentCall({
      runSpy,
      agentId: "main",
      expectedHeartbeatEvery: "600000ms",
      startIndex: 1,
    });
    expectAgentCall({
      runSpy,
      agentId: "ops",
      expectedHeartbeatEvery: "900000ms",
      startIndex: 1,
    });

    runner.stop();
  });

  it("uses the persisted monitor cadence for scheduled ticks and later cooldown", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startDefaultRunner(runSpy);
    await vi.advanceTimersByTimeAsync(42_000);

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
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

    requestHeartbeat({
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      agentId: "main",
      scheduledEveryMs: 5 * 60_000,
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
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await pokeIntervalWake("main");
    await pokeIntervalWake("ops");

    const agentIds = runSpy.mock.calls.map((call) => call[0]?.agentId);
    expect(agentIds).toContain("main");
    expect(agentIds).toContain("ops");

    runner.stop();
  });

  it("does not let a slow agent block another agent's broadcast wake", async () => {
    useFakeHeartbeatTime();
    let finishMain: (() => void) | undefined;
    const mainFinished = new Promise<void>((resolve) => {
      finishMain = resolve;
    });
    const runSpy = vi.fn(async ({ agentId }: { agentId?: string }) => {
      if (agentId === "main") {
        await mainFinished;
      }
      return { status: "ran", durationMs: 1 } as const;
    });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main" }, { id: "ops" }]),
      runOnce: runSpy,
    });

    requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy.mock.calls.map(([options]) => options.agentId)).toEqual(["main", "ops"]);

    finishMain?.();
    await vi.advanceTimersByTimeAsync(0);
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

    // First interval poke fires and throws inside runOnce.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
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

    // Start runner A
    const runnerA = startHeartbeatRunner({
      cfg,
      runOnce: runSpy1,
    });

    // Start runner B (simulates lifecycle reload)
    const runnerB = startHeartbeatRunner({
      cfg,
      runOnce: runSpy2,
    });

    // Stop runner A (stale cleanup) — should NOT kill runner B's handler
    runnerA.stop();

    // Runner B should still serve interval wakes
    await vi.advanceTimersByTimeAsync(30 * 60_000);
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

  it.each([
    { label: "a disabled heartbeat", outcome: { status: "skipped", reason: "disabled" } },
    {
      label: "a terminal tool failure",
      outcome: { status: "failed", reason: "agent-tool-failure" },
    },
  ] as const)(
    "retains event follow-ups after $label until the spacing floor",
    async ({ outcome }) => {
      useFakeHeartbeatTime();
      const runSpy = vi.fn().mockResolvedValue(outcome);
      const intervalMs = 10 * 60_000;
      const runner = startHeartbeatRunner({
        cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "10m" } }]),
        runOnce: runSpy,
      });
      await vi.advanceTimersByTimeAsync(intervalMs);
      await pokeIntervalWake("main", intervalMs);
      expect(runSpy).toHaveBeenCalledTimes(1);

      requestHeartbeat(wake("exec-event", { agentId: "main", coalesceMs: 0 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(runSpy).toHaveBeenCalledTimes(1);

      // Deferred work survives runner replacement, so this test must consume its
      // retained wake before leaving the shared process-global queue.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runSpy).toHaveBeenCalledTimes(2);
      runner.stop();
    },
  );

  it("flood guard defers due interval wakes after repeated runs", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 } as const);

    const intervalMs = 1_000;
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "1s" } }]),
      runOnce: runSpy,
    });
    await vi.advanceTimersByTimeAsync(intervalMs);
    await pokeIntervalWake("main", intervalMs);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs);
      await pokeIntervalWake("main", intervalMs);
    }
    expect(runSpy).toHaveBeenCalledTimes(5);

    // Five runs inside the flood window: the next due interval poke defers
    // via the flood guard, and the deferral is terminal (no wake-layer retry).
    await vi.advanceTimersByTimeAsync(intervalMs);
    await pokeIntervalWake("main", intervalMs);
    expect(runSpy).toHaveBeenCalledTimes(5);

    runner.stop();
  });

  it("does not delay the next cron tick after repeated requests-in-flight skips", async () => {
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
    });
    const intervalMs = 30 * 60_000;
    const firstDueMs = intervalMs;

    // Poke the first heartbeat at the agent's first slot — returns
    // requests-in-flight, so no bookkeeping is recorded.
    await vi.advanceTimersByTimeAsync(firstDueMs);
    await pokeIntervalWake();
    expect(runSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(runSpy).toHaveBeenCalledTimes(6);
    const scheduledSlotCallsBeforeInterval = callTimes.filter(
      (time) => time >= firstDueMs + intervalMs,
    );
    expect(scheduledSlotCallsBeforeInterval).toStrictEqual([]);

    // The persisted cron slot still fires after retries; retry completion must
    // not overwrite cron's authoritative schedule.
    await vi.advanceTimersByTimeAsync(firstDueMs + intervalMs - Date.now() + 1);
    await pokeIntervalWake();
    const scheduledSlotCallsAfterInterval = callTimes.filter(
      (time) => time >= firstDueMs + intervalMs,
    );
    expect(scheduledSlotCallsAfterInterval.length).toBeGreaterThan(0);

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
              to: "discord:dm:ops",
              accountId: "ops-account",
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

  it("keeps non-cron targeted wake destination overrides explicit", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        ...heartbeatConfig([
          {
            id: "ops",
            heartbeat: {
              every: "15m",
              target: "discord:channel:ops",
              to: "discord:dm:ops",
              accountId: "ops-account",
            },
          },
        ]),
      } as OpenClawConfig,
      runSpy,
      wake: {
        source: "hook",
        intent: "event",
        reason: "hook:job-123",
        agentId: "ops",
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: { target: "last" },
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "hook:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
        heartbeat: {
          every: "15m",
          target: "last",
          to: "discord:dm:ops",
          accountId: "ops-account",
        },
      },
    });

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
    const financeCalls = runSpy.mock.calls.filter((call) => call[0]?.agentId === "finance");
    expect(financeCalls).toStrictEqual([]);

    runner.stop();
  });

  // Regression for runaway heartbeat loop: backgrounded `process.start` exits
  // call `requestHeartbeat({reason: "exec-event"})` from
  // `bash-tools.exec-runtime.ts:347` (`maybeNotifyOnExit`). If a heartbeat run
  // uses backgrounded tools (response-tracker sync, conversation monitors,
  // etc.), each background process exit triggers another heartbeat run because
  // targeted dispatch previously bypassed cooldown entirely. Observed in
  // production: a 30m heartbeat fired every ~10s and pegged the event loop.
  it("does not bypass interval cooldown for repeated exec-event wakes", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
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
    // exits, fired well within the configured 30m interval. They coalesce into
    // one retained turn after the 30s floor instead of running every 10s.
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

    // Total elapsed: ~40s. The queued events produced one follow-up at the
    // spacing boundary; they did not bypass the floor or wait for the 30m tick.
    expect(runSpy).toHaveBeenCalledTimes(2);

    // Settle the final retained batch so this module-level wake queue is empty
    // before the next runner lifecycle starts.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runSpy).toHaveBeenCalledTimes(3);

    runner.stop();
  });

  it("retains an event that collides with a task until the spacing floor", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 0,
    });
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(runSpy, 0, {
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });

    await vi.advanceTimersByTimeAsync(29_998);
    expect(runSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expectRunCallFields(runSpy, 1, { intent: "event", reason: "exec-event" });
    expect(getRunCall(runSpy, 1).tasks).toEqual([]);
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

  it.each([
    {
      name: "an agent without a heartbeat schedule",
      cfg: {
        agents: { list: [{ id: "main", heartbeat: { every: "30m" } }, { id: "ops" }] },
      } as OpenClawConfig,
      agentId: "ops",
      sessionKey: "agent:ops:main",
      heartbeat: { target: "last" },
    },
    {
      name: "the global main session when periodic heartbeats are disabled",
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
        session: { scope: "global" },
      } as OpenClawConfig,
      agentId: "main",
      sessionKey: "global",
      heartbeat: { every: "0m", target: "last" },
    },
  ])("runs one targeted notification wake for $name", async (testCase) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: testCase.cfg,
      runSpy,
      wake: {
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        ...(testCase.sessionKey === "global" ? { agentId: testCase.agentId } : {}),
        sessionKey: testCase.sessionKey,
        heartbeat: { target: "last" },
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: testCase.agentId,
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        sessionKey: testCase.sessionKey,
        heartbeat: testCase.heartbeat,
      },
    });
    runner.stop();
  });

  it("rejects targeted notification wakes for unconfigured agents", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: { agents: { list: [{ id: "main", heartbeat: { every: "30m" } }] } } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:bogus:main",
      heartbeat: { target: "last" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
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
    expectRunCallFields(runSpy, 1, {
      reason: "background-task-blocked",
      sessionKey: "agent:main:main",
    });
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

  it.each([
    [HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, 1_500],
    [HEARTBEAT_SKIP_PREEMPTED, 60_500],
  ])("retryable %s does not poison the next retry", async (skipReason, retryDelayMs) => {
    useFakeHeartbeatTime();
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: skipReason })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startDefaultRunner(runSpy);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(retryDelayMs);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expectRunCallFields(runSpy, 1, {
      reason: "exec-event",
      sessionKey: "agent:main:main",
    });
    runner.stop();
  });
});
