import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getHeartbeatWakeAbortSignal,
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat wake target concurrency", () => {
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  type HeartbeatWakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  let currentHandlerDisposer: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: HeartbeatWakeHandler): void {
    currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(handler);
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      currentHandlerDisposer?.();
      currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    currentHandlerDisposer?.();
    currentHandlerDisposer = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { reason: "requests-in-flight", delay: 1_000, siblingAllowed: false },
    { reason: "cron-in-progress", delay: 4_500, siblingAllowed: false },
    { reason: "throw", delay: 1_000, siblingAllowed: false },
    { reason: "min-spacing", delay: 4_500, siblingAllowed: true },
  ])(
    "honors $reason before the remaining selected target work",
    async ({ reason, delay, siblingAllowed }) => {
      vi.useFakeTimers();
      const target = { agentId: "main", sessionKey: "agent:main:main" };
      let first = true;
      const handler = vi.fn(async (request: WakeRequest) => {
        if (request.intent === "event" && first) {
          first = false;
          if (reason === "throw") {
            throw new Error("temporary admission failure");
          }
          return {
            status: "skipped" as const,
            reason,
            ...(delay === 4_500 ? { retryAtMs: Date.now() + delay } : {}),
          };
        }
        return { status: "ran" as const, durationMs: 1 };
      });
      setHeartbeatWakeHandler(handler);
      const settled = vi.fn();
      const event = requestHeartbeatAndWait({
        ...target,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        coalesceMs: 100,
      }).then(settled);
      await vi.advanceTimersByTimeAsync(1);
      const task = requestHeartbeatAndWait({
        ...target,
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:inbox",
        tasks: [{ jobId: "inbox", name: "inbox", prompt: "Check inbox" }],
        coalesceMs: 99,
      }).then(settled);
      await vi.advanceTimersByTimeAsync(99);
      const initial = siblingAllowed ? ["event", "task"] : ["event"];
      expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(initial);
      expect(settled).toHaveBeenCalledTimes(siblingAllowed ? 1 : 0);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(initial);
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(
        siblingAllowed ? ["event", "task", "event"] : ["event", "event", "task"],
      );
      await Promise.all([event, task]);
      expect(settled).toHaveBeenCalledTimes(2);
      expect(settled.mock.calls.map(([result]) => result)).toEqual([
        { status: "ran", durationMs: 1 },
        { status: "ran", durationMs: 1 },
      ]);
    },
  );

  it.each(["source", "reason"] as const)(
    "retains retry event intent when a scheduled tick wins %s priority",
    async (retryField) => {
      vi.useFakeTimers();
      const handler = vi
        .fn()
        .mockImplementationOnce(async () => ({
          status: "skipped",
          reason: "flood",
          retryAtMs: Date.now() + 500,
        }))
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      setHeartbeatWakeHandler(handler);
      const settled = vi.fn();
      const target = { agentId: "main", sessionKey: "agent:main:main", coalesceMs: 100 };
      const event = requestHeartbeatAndWait({
        ...target,
        source: retryField === "source" ? "retry" : "exec-event",
        reason: retryField === "reason" ? "retry" : "exec-event",
        intent: "event",
      }).then(settled);
      const scheduled = requestHeartbeatAndWait({
        ...target,
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        scheduledEveryMs: 5_000,
      }).then(settled);
      await vi.advanceTimersByTimeAsync(100);
      expect(handler).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(499);
      expect(handler).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      for (const [request] of handler.mock.calls) {
        expect(request).toMatchObject({
          intent: "event",
          source: "interval",
          reason: "interval",
          scheduledEveryMs: 5_000,
        });
      }
      await Promise.all([event, scheduled]);
      expect(settled.mock.calls.map(([result]) => result)).toEqual([
        { status: "ran", durationMs: 1 },
        { status: "ran", durationMs: 1 },
      ]);
    },
  );

  it("preserves the target concurrency bound across heartbeat handler replacement", async () => {
    vi.useFakeTimers();
    const finishOldWakeByAgent = new Map<string, () => void>();
    const finishNewWakeByAgent = new Map<string, () => void>();
    const oldWakeSignals: AbortSignal[] = [];
    let peakActiveWakeCount = 0;
    const oldHandler = vi.fn(async (request: WakeRequest) => {
      peakActiveWakeCount = Math.max(peakActiveWakeCount, getActiveGatewayRootWorkCount());
      const signal = getHeartbeatWakeAbortSignal();
      if (signal) {
        oldWakeSignals.push(signal);
      }
      await new Promise<void>((resolve) => {
        finishOldWakeByAgent.set(request.agentId ?? "", resolve);
      });
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(oldHandler);

    function requestTarget(agentId: string): void {
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:${agentId}`,
        agentId,
        sessionKey: `agent:${agentId}:main`,
        coalesceMs: 0,
      });
    }

    for (let index = 0; index < 4; index += 1) {
      requestTarget(`target-${index}`);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(oldHandler).toHaveBeenCalledTimes(4);
    expect(getActiveGatewayRootWorkCount()).toBe(4);

    const newHandler = vi.fn(async (request: WakeRequest) => {
      peakActiveWakeCount = Math.max(peakActiveWakeCount, getActiveGatewayRootWorkCount());
      await new Promise<void>((resolve) => {
        finishNewWakeByAgent.set(request.agentId ?? "", resolve);
      });
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(newHandler);
    requestTarget("target-0");
    for (let index = 4; index < 8; index += 1) {
      requestTarget(`target-${index}`);
    }

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(oldWakeSignals).toHaveLength(4);
      expect(oldWakeSignals.every((signal) => signal.aborted)).toBe(true);
      expect(newHandler.mock.calls.map(([request]) => request.agentId)).toEqual([
        "target-0",
        "target-4",
        "target-5",
        "target-6",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(4);

      finishNewWakeByAgent.get("target-0")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(newHandler.mock.calls.map(([request]) => request.agentId)).toEqual([
        "target-0",
        "target-4",
        "target-5",
        "target-6",
        "target-7",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(4);
    } finally {
      for (let index = 0; index < 9; index += 1) {
        for (const finishWake of finishOldWakeByAgent.values()) {
          finishWake();
        }
        for (const finishWake of finishNewWakeByAgent.values()) {
          finishWake();
        }
        await vi.advanceTimersByTimeAsync(0);
      }
    }

    expect(newHandler).toHaveBeenCalledTimes(8);
    expect(peakActiveWakeCount).toBe(4);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("aborts the disposed generation without letting its stale disposer abort a replacement", async () => {
    vi.useFakeTimers();
    let finishOldWake: (() => void) | undefined;
    let finishNewWake: (() => void) | undefined;
    const oldWakeFinished = new Promise<void>((resolve) => {
      finishOldWake = resolve;
    });
    const newWakeFinished = new Promise<void>((resolve) => {
      finishNewWake = resolve;
    });
    let oldSignal: AbortSignal | undefined;
    let newSignal: AbortSignal | undefined;
    const oldHandler = vi.fn(async () => {
      oldSignal = getHeartbeatWakeAbortSignal();
      await oldWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    const disposeOld = setRuntimeHeartbeatWakeHandler(oldHandler);
    currentHandlerDisposer = disposeOld;
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "generation-owned",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(oldSignal?.aborted).toBe(false);

    disposeOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSignal?.aborted).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const newHandler = vi.fn(async () => {
      newSignal = getHeartbeatWakeAbortSignal();
      await newWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    const disposeNew = setRuntimeHeartbeatWakeHandler(newHandler);
    currentHandlerDisposer = disposeNew;
    await vi.advanceTimersByTimeAsync(250);
    expect(newHandler).toHaveBeenCalledOnce();
    expect(newSignal?.aborted).toBe(false);

    disposeOld();
    expect(newSignal?.aborted).toBe(false);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    disposeNew();
    finishOldWake?.();
    finishNewWake?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(newSignal?.aborted).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps task and event wakes for the same target serialized", async () => {
    vi.useFakeTimers();
    let finishTask: (() => void) | undefined;
    const taskFinished = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.intent === "task") {
        await taskFinished;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:deployment",
      agentId: "main",
      sessionKey: "agent:main:main",
      tasks: [{ jobId: "deployment", name: "deployment", prompt: "Check deployment" }],
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:deployment",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 100,
    });

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(["task"]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finishTask?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(["task", "event"]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
