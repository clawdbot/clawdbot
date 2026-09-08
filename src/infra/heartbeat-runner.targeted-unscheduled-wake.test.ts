// Tests targeted unscheduled heartbeat wake dispatch for configured agents
// without a recurring heartbeat schedule. Split out of
// heartbeat-runner.scheduler.test.ts so that file stays inside the oxlint
// max-lines budget.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { wake as wakeCronService } from "../cron/service/wake.js";
import { setHeartbeatsEnabled, startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("startHeartbeatRunner targeted unscheduled wake dispatch", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  type MockRunOnce = RunOnce & { mock: { calls: unknown[][] } };
  const targetedWakeCases = [
    {
      name: "cron",
      wake: {
        source: "cron",
        intent: "immediate",
        reason: "cron:one-shot",
        agentId: "main",
      },
    },
    {
      name: "manual",
      wake: {
        source: "manual",
        intent: "immediate",
        reason: "wake",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "notification",
      wake: {
        source: "notifications-event",
        intent: "immediate",
        reason: "wake",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "restart sentinel",
      wake: {
        source: "restart-sentinel",
        intent: "immediate",
        reason: "wake",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "hook",
      wake: {
        source: "hook",
        intent: "immediate",
        reason: "hook:123e4567-e89b-12d3-a456-426614174000",
        agentId: "main",
      },
    },
    {
      name: "exec event",
      wake: {
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "background task",
      wake: {
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "blocked background task",
      wake: {
        source: "background-task-blocked",
        intent: "immediate",
        reason: "background-task-blocked",
        sessionKey: "agent:main:main",
      },
    },
  ] as const;
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
    });

    requestHeartbeat(params.wake);
    await vi.advanceTimersByTimeAsync(1);

    expect(params.runSpy).toHaveBeenCalledTimes(1);
    expectRunCallFields(params.runSpy, 0, params.expectedCall);

    return runner;
  }

  afterEach(() => {
    setHeartbeatsEnabled(true);
    resetConfigRuntimeState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["now", "next-heartbeat"] as const)(
    "runs a targeted manual %s wake when recurring heartbeats are disabled",
    async (mode) => {
      useFakeHeartbeatTime();
      const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg: {
          agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
        } as OpenClawConfig,
        runOnce: runSpy,
      });
      const enqueueSystemEvent = vi.fn();
      const state = {
        deps: {
          enqueueSystemEvent,
          requestHeartbeat: (wake: Parameters<typeof requestHeartbeat>[0]) =>
            requestHeartbeat({ ...wake, coalesceMs: 0 }),
        },
      } as unknown as Parameters<typeof wakeCronService>[0];

      expect(
        wakeCronService(state, {
          mode,
          text: "Operator requested a session update.",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      ).toEqual({ ok: true });
      expect(enqueueSystemEvent).toHaveBeenCalledWith("Operator requested a session update.", {
        agentId: "main",
        sessionKey: "agent:main:main",
      });

      await vi.advanceTimersByTimeAsync(1);

      expect(runSpy).toHaveBeenCalledOnce();
      expectRunCallFields(runSpy, 0, {
        agentId: "main",
        source: "manual",
        intent: "immediate",
        reason: "wake",
        sessionKey: "agent:main:main",
      });
      runner.stop();
    },
  );

  it.each(
    targetedWakeCases.flatMap((testCase) =>
      ["0m", "30m"].map((heartbeatEvery) => ({
        name: testCase.name,
        wake: testCase.wake,
        heartbeatEvery,
      })),
    ),
  )("runs one targeted $name wake with heartbeat cadence $heartbeatEvery", async (testCase) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = await expectWakeDispatch({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: testCase.heartbeatEvery } },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
      runSpy,
      wake: { ...testCase.wake, coalesceMs: 0 },
      expectedCall: testCase.wake,
    });
    runner.stop();
  });

  it.each([
    {
      name: "without a session target",
      wake: { agentId: "main", sessionKey: undefined },
    },
    {
      name: "for an unconfigured agent",
      wake: { agentId: "unknown", sessionKey: "agent:unknown:main" },
    },
    {
      name: "with event intent",
      wake: { agentId: "main", sessionKey: "agent:main:main", intent: "event" as const },
    },
    {
      name: "with a non-manual reason",
      wake: { agentId: "main", sessionKey: "agent:main:main", reason: "manual" },
    },
  ])("rejects an unscheduled manual wake $name", async ({ wake }) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      ...wake,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });

  it.each(targetedWakeCases)("keeps targeted $name wakes globally disabled", async (testCase) => {
    useFakeHeartbeatTime();
    setHeartbeatsEnabled(false);
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({ ...testCase.wake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });

  it.each([
    { name: "event intent", wake: { intent: "event" as const } },
    { name: "a non-namespaced reason", wake: { reason: "cron" } },
    { name: "another source's reason", wake: { reason: "wake" } },
    { name: "a non-cron source", wake: { source: "manual" as const } },
    { name: "no target", wake: { agentId: undefined } },
  ])("rejects an unscheduled cron wake with $name", async ({ wake }) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: "cron:one-shot",
      agentId: "main",
      ...wake,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });

  it.each([
    {
      name: "without a session target",
      wake: { agentId: "main", sessionKey: undefined },
    },
    {
      name: "with event intent",
      wake: { agentId: "main", sessionKey: "agent:main:main", intent: "event" as const },
    },
    {
      name: "with a non-wake reason",
      wake: { agentId: "main", sessionKey: "agent:main:main", reason: "manual" },
    },
  ])("rejects an unscheduled restart-sentinel wake $name", async ({ wake }) => {
    useFakeHeartbeatTime();
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: {
        agents: { defaults: { heartbeat: { every: "0m" } }, list: [{ id: "main" }] },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      ...wake,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).not.toHaveBeenCalled();
    runner.stop();
  });

  it.each(targetedWakeCases)(
    "rejects targeted $name wakes for unconfigured agents",
    async (testCase) => {
      useFakeHeartbeatTime();
      const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg: { agents: { list: [{ id: "main" }] } } as OpenClawConfig,
        runOnce: runSpy,
      });

      requestHeartbeat({
        ...testCase.wake,
        agentId: "unknown",
        sessionKey: "agent:unknown:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(runSpy).not.toHaveBeenCalled();
      runner.stop();
    },
  );

  it.each(["0m", "30m"])(
    "retains the shared flood limit through reload with cadence %s",
    async (every) => {
      useFakeHeartbeatTime();
      const cfg: OpenClawConfig = {
        agents: { defaults: { heartbeat: { every } }, list: [{ id: "main" }] },
      };
      const callTimes: number[] = [];
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: async () => {
          callTimes.push(Date.now());
          return { status: "ran", durationMs: 0 };
        },
      });
      try {
        for (let i = 0; i < 5; i++) {
          requestHeartbeat({
            source: "background-task",
            intent: "immediate",
            reason: "background-task",
            sessionKey: "agent:main:main",
            coalesceMs: 0,
          });
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(callTimes).toEqual([0, 1, 2, 3, 4]);
        runner.updateConfig(cfg);
        requestHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          sessionKey: "agent:main:main",
          coalesceMs: 0,
        });
        await vi.advanceTimersByTimeAsync(60_000 - Date.now());
        expect(callTimes).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(1);
        expect(callTimes).toEqual([0, 1, 2, 3, 4, 60_001]);
      } finally {
        runner.stop();
      }
    },
  );

  it.each(["0m", "30m"])(
    "preserves an in-flight start across a reload with cadence %s",
    async (every) => {
      useFakeHeartbeatTime();
      const cfg: OpenClawConfig = {
        agents: { defaults: { heartbeat: { every } }, list: [{ id: "main" }] },
      };
      const release = createDeferred();
      const callTimes: number[] = [];
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: async () => {
          callTimes.push(Date.now());
          await release.promise;
          return { status: "ran", durationMs: 0 };
        },
      });
      const wakeEvent = () =>
        requestHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          sessionKey: "agent:main:main",
          coalesceMs: 0,
        });
      try {
        wakeEvent();
        await vi.advanceTimersByTimeAsync(1);
        expect(callTimes).toEqual([0]);
        runner.updateConfig(cfg);
        release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        wakeEvent();
        await vi.advanceTimersByTimeAsync(29_999 - Date.now());
        expect(callTimes).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1);
        expect(callTimes).toEqual([0, 30_000]);
      } finally {
        release.resolve();
        runner.stop();
      }
    },
  );

  it.each([undefined, { every: "0m" }])(
    "keeps event spacing through enrollment changes for %j without adding broadcast wakes",
    async (heartbeat) => {
      useFakeHeartbeatTime();
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", heartbeat },
            { id: "ops", heartbeat: { every: "1m" } },
          ],
        },
      };
      const calls: { agentId: string | undefined; at: number }[] = [];
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: async ({ agentId }) => {
          calls.push({ agentId, at: Date.now() });
          return { status: "ran", durationMs: 0 };
        },
      });
      const wakeEvent = () =>
        requestHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          sessionKey: "agent:main:main",
          coalesceMs: 0,
        });
      try {
        wakeEvent();
        await vi.advanceTimersByTimeAsync(1);
        runner.updateConfig({
          agents: {
            list: [
              { id: "main", heartbeat: { every: "1m" } },
              { id: "ops", heartbeat: { every: "1m" } },
            ],
          },
        });
        runner.updateConfig(cfg);
        wakeEvent();
        await vi.advanceTimersByTimeAsync(29_999 - Date.now());
        expect(calls).toEqual([{ agentId: "main", at: 0 }]);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toEqual([
          { agentId: "main", at: 0 },
          { agentId: "main", at: 30_000 },
        ]);
        requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toEqual([
          { agentId: "main", at: 0 },
          { agentId: "main", at: 30_000 },
          { agentId: "ops", at: 30_000 },
        ]);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(calls).toHaveLength(3);
      } finally {
        runner.stop();
      }
    },
  );
});
