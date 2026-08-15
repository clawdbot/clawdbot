// Tests heartbeat runner targeted wake routing: agent/session scoping, trusted
// continuation routing, lineage containment, override merging, and immediate
// delivery for repeated bare, exec-event, notification, and background-task wakes.
// Split out of heartbeat-runner.scheduler.test.ts; shared fixtures live in
// heartbeat-runner.scheduler.test-support.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  expectRunCallFields,
  expectWakeDispatch,
  getRunCall,
  heartbeatConfig,
  TEST_SCHEDULER_SEED,
  useFakeHeartbeatTime,
  wake,
} from "./heartbeat-runner.scheduler.test-support.js";
import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatRaw as requestHeartbeat,
} from "./heartbeat-wake.js";

describe("startHeartbeatRunner targeted wakes", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
        parentRunId: "run-targeted-parent",
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        reason: "cron:job-123",
        sessionKey: "agent:ops:discord:channel:alerts",
        parentRunId: "run-targeted-parent",
      },
    });

    runner.stop();
  });

  it("preserves trusted continuation routing through the wake-handler handoff", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: heartbeatConfig([{ id: "main", heartbeat: { every: "30m" } }]),
      runSpy,
      wake: markTrustedContinuationHeartbeatWake(
        wake("delegate-return", {
          agentId: "main",
          sessionKey: "agent:main:subagent:trusted",
          coalesceMs: 0,
        }),
      ),
      expectedCall: {
        agentId: "main",
        reason: "delegate-return",
        sessionKey: "agent:main:subagent:trusted",
        trustedContinuationRouting: true,
      },
    });

    runner.stop();
  });

  it("does not fan out parent run lineage across untargeted wakes", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig([
        { id: "main", heartbeat: { every: "30m" } },
        { id: "ops", heartbeat: { every: "15m" } },
      ]),
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat(
      wake("delegate-return", {
        parentRunId: "run-untargeted-parent",
        coalesceMs: 0,
      }),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    for (let callIndex = 0; callIndex < 2; callIndex++) {
      const options = expectRunCallFields(runSpy, callIndex, {
        reason: "delegate-return",
      });
      expect(options.parentRunId).toBeUndefined();
    }

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
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
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

  it("runs a targeted notification wake for an agent without a heartbeat schedule", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          list: [{ id: "main", heartbeat: { every: "30m" } }, { id: "ops" }],
        },
      } as OpenClawConfig,
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:ops:main",
      heartbeat: { target: "last" },
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(runSpy, 0, {
      agentId: "ops",
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:ops:main",
      heartbeat: { target: "last" },
    });
    runner.stop();
  });

  it("rejects targeted notification wakes for unconfigured agents", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: { agents: { list: [{ id: "main", heartbeat: { every: "30m" } }] } } as OpenClawConfig,
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
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
    expectRunCallFields(runSpy, 1, {
      reason: "background-task-blocked",
      sessionKey: "agent:main:main",
    });
    runner.stop();
  });
});
