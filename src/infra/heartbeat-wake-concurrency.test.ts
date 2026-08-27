import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getHeartbeatWakeAbortSignal,
  requestHeartbeat,
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

  it("holds a post-barrier target while an earlier unscoped wake coalesces", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(async (_request: WakeRequest) => ({
      status: "ran" as const,
      durationMs: 1,
    }));
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "test-delayed-global-flush",
      coalesceMs: 1_000,
    });
    requestHeartbeat({
      source: "background-task",
      intent: "immediate",
      reason: "background-task",
      agentId: "main",
      sessionKey: "agent:main:guildchat:channel:123",
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "test-delayed-global-flush",
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "test-delayed-global-flush",
      "background-task",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("starts independent target wakes without waiting for a blocked agent", async () => {
    vi.useFakeTimers();
    let finishBlockedWake: (() => void) | undefined;
    const blockedWake = new Promise<void>((resolve) => {
      finishBlockedWake = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.agentId === "blocked") {
        await blockedWake;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    for (const agentId of ["blocked", "ready-a", "ready-b"]) {
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:${agentId}`,
        agentId,
        sessionKey: `agent:${agentId}:main`,
        coalesceMs: 100,
      });
    }

    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(handler.mock.calls.map(([request]) => request.agentId)).toEqual([
        "blocked",
        "ready-a",
        "ready-b",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finishBlockedWake?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("starts newly requested target wakes while another agent remains blocked", async () => {
    vi.useFakeTimers();
    let finishBlockedWake: (() => void) | undefined;
    const blockedWake = new Promise<void>((resolve) => {
      finishBlockedWake = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.agentId === "blocked") {
        await blockedWake;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:blocked",
      agentId: "blocked",
      sessionKey: "agent:blocked:main",
      coalesceMs: 0,
    });

    try {
      await vi.advanceTimersByTimeAsync(1);
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: "cron:ready",
        agentId: "ready",
        sessionKey: "agent:ready:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.agentId)).toEqual(["blocked", "ready"]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finishBlockedWake?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("serializes redundant agent-plus-session identity with the same canonical session", async () => {
    vi.useFakeTimers();
    let finishFirstWake: (() => void) | undefined;
    const firstWakeFinished = new Promise<void>((resolve) => {
      finishFirstWake = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === "session-only") {
        await firstWakeFinished;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const sessionKey = "agent:main:guildchat:channel:123";

    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "session-only",
      sessionKey,
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "redundant-agent",
      agentId: "main",
      sessionKey,
      coalesceMs: 0,
    });

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.reason)).toEqual(["session-only"]);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finishFirstWake?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "session-only",
      "redundant-agent",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("runs an unscoped wake as an exclusive barrier between targeted groups", async () => {
    vi.useFakeTimers();
    let finishBeforeBarrier: (() => void) | undefined;
    let finishBarrier: (() => void) | undefined;
    const beforeBarrierFinished = new Promise<void>((resolve) => {
      finishBeforeBarrier = resolve;
    });
    const barrierFinished = new Promise<void>((resolve) => {
      finishBarrier = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === "before-barrier") {
        await beforeBarrierFinished;
      } else if (request.reason === "global-barrier") {
        await barrierFinished;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "before-barrier",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "global-barrier",
      coalesceMs: 0,
    });
    for (const agentId of ["ops", "support"]) {
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `after-barrier:${agentId}`,
        sessionKey: `agent:${agentId}:main`,
        coalesceMs: 0,
      });
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual(["before-barrier"]);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    finishBeforeBarrier?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "before-barrier",
      "global-barrier",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    finishBarrier?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "before-barrier",
      "global-barrier",
      "after-barrier:ops",
      "after-barrier:support",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("bounds concurrent target wakes and starts queued targets as slots open", async () => {
    vi.useFakeTimers();
    const finishWakeByAgent = new Map<string, () => void>();
    let peakActiveWakeCount = 0;
    const handler = vi.fn(async (request: WakeRequest) => {
      peakActiveWakeCount = Math.max(peakActiveWakeCount, getActiveGatewayRootWorkCount());
      await new Promise<void>((resolve) => {
        finishWakeByAgent.set(request.agentId ?? "", resolve);
      });
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    for (let index = 0; index < 9; index += 1) {
      const agentId = `target-${index}`;
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:${agentId}`,
        agentId,
        sessionKey: `agent:${agentId}:main`,
        coalesceMs: 0,
      });
    }

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.agentId)).toEqual([
        "target-0",
        "target-1",
        "target-2",
        "target-3",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(4);

      finishWakeByAgent.get("target-0")?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler.mock.calls.map(([request]) => request.agentId)).toEqual([
        "target-0",
        "target-1",
        "target-2",
        "target-3",
        "target-4",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(4);
    } finally {
      for (let index = 0; index < 9; index += 1) {
        for (const finishWake of finishWakeByAgent.values()) {
          finishWake();
        }
        await vi.advanceTimersByTimeAsync(0);
      }
    }

    expect(handler).toHaveBeenCalledTimes(9);
    expect(peakActiveWakeCount).toBe(4);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

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

  it("does not apply an active target's old delay to a newly ready wake", async () => {
    vi.useFakeTimers();
    let finishBlockedWake: (() => void) | undefined;
    const blockedWake = new Promise<void>((resolve) => {
      finishBlockedWake = resolve;
    });
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === "cron:blocked") {
        await blockedWake;
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:blocked",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 30_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      requestHeartbeat({
        source: "manual",
        intent: "manual",
        reason: "manual",
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      finishBlockedWake?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:blocked",
      "manual",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("does not delay a ready target behind another target's deferred retry", async () => {
    vi.useFakeTimers();
    let finishBlockedWake: (() => void) | undefined;
    const blockedWake = new Promise<void>((resolve) => {
      finishBlockedWake = resolve;
    });
    let deferredAttempts = 0;
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === "cron:blocked") {
        await blockedWake;
      }
      if (request.agentId === "deferred" && deferredAttempts++ === 0) {
        return {
          status: "skipped" as const,
          reason: "not-due",
          retryAtMs: Date.now() + 30_000,
        };
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:blocked",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });

    try {
      await vi.advanceTimersByTimeAsync(1);
      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        agentId: "deferred",
        sessionKey: "agent:deferred:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      requestHeartbeat({
        source: "manual",
        intent: "manual",
        reason: "manual",
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
        "cron:blocked",
        "exec-event",
      ]);
    } finally {
      finishBlockedWake?.();
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:blocked",
      "exec-event",
      "manual",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:blocked",
      "exec-event",
      "manual",
      "exec-event",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
