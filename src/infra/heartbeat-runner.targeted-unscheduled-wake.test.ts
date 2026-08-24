// Tests targeted unscheduled heartbeat wake dispatch for configured agents
// without a recurring heartbeat schedule. Split out of
// heartbeat-runner.scheduler.test.ts so that file stays inside the oxlint
// max-lines budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("startHeartbeatRunner targeted unscheduled wake dispatch", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  type MockRunOnce = RunOnce & { mock: { calls: unknown[][] } };
  const TEST_SCHEDULER_SEED = "heartbeat-runner-test-seed";

  function useFakeHeartbeatTime() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
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

  async function expectWakeDispatch(params: {
    cfg: OpenClawConfig;
    runSpy: MockRunOnce;
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
    expectRunCallFields(params.runSpy, 0, params.expectedCall);

    return runner;
  }

  afterEach(() => {
    resetConfigRuntimeState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "session-targeted", sessionKey: "agent:ops:main" },
    { name: "agent-targeted", sessionKey: undefined },
  ])("runs one $name hook wake for an agent without a heartbeat schedule", async (testCase) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        agents: { list: [{ id: "main", heartbeat: { every: "30m" } }, { id: "ops" }] },
      } as OpenClawConfig,
      runSpy,
      wake: {
        source: "hook",
        intent: "immediate",
        reason: "hook:123e4567-e89b-12d3-a456-426614174000",
        agentId: "ops",
        sessionKey: testCase.sessionKey,
        coalesceMs: 0,
      },
      expectedCall: {
        agentId: "ops",
        source: "hook",
        intent: "immediate",
        reason: "hook:123e4567-e89b-12d3-a456-426614174000",
        sessionKey: testCase.sessionKey,
      },
    });
    runner.stop();
  });

  it.each([
    { source: "background-task", reason: "background-task" },
    { source: "background-task-blocked", reason: "background-task-blocked" },
  ] as const)(
    "runs one targeted unscheduled $source wake for a configured agent",
    async ({ source, reason }) => {
      useFakeHeartbeatTime();
      const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = await expectWakeDispatch({
        cfg: {
          agents: { list: [{ id: "main", heartbeat: { every: "30m" } }, { id: "ops" }] },
        } as OpenClawConfig,
        runSpy,
        wake: {
          source,
          intent: "immediate",
          reason,
          sessionKey: "agent:ops:main",
          coalesceMs: 0,
        },
        expectedCall: {
          agentId: "ops",
          source,
          intent: "immediate",
          reason,
          sessionKey: "agent:ops:main",
        },
      });
      runner.stop();
    },
  );

  it("runs one targeted exec-event wake when heartbeat cadence is disabled", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
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
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
      },
    });
    runner.stop();
  });

  it("rejects targeted hook wakes for unconfigured agents", async () => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: { agents: { list: [{ id: "main", heartbeat: { every: "30m" } }] } } as OpenClawConfig,
      runOnce: runSpy,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });

    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "hook:123e4567-e89b-12d3-a456-426614174000",
      agentId: "bogus",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });
});
