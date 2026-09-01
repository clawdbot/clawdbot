// Exercises heartbeat wake timer, handler lifecycle, and target forwarding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeatRaw as requestHeartbeat,
  requestHeartbeatAndWait,
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat-wake", () => {
  type HeartbeatWakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  let currentHandlerDisposer: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: HeartbeatWakeHandler): () => void {
    const dispose = setRuntimeHeartbeatWakeHandler(handler);
    currentHandlerDisposer = dispose;
    return () => {
      dispose();
      if (currentHandlerDisposer === dispose) {
        currentHandlerDisposer = undefined;
      }
    };
  }

  function wake(reason: string, opts: Partial<WakeRequest> = {}): WakeRequest {
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
              : reason.startsWith("cron:")
                ? "cron"
                : reason.startsWith("hook:")
                  ? "hook"
                  : "other");
    const intent =
      opts.intent ??
      (reason === "interval" ? "scheduled" : reason === "manual" ? "manual" : "event");
    return { source, intent, reason, ...opts };
  }

  function setRetryOnceHeartbeatHandler() {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    return handler;
  }

  function expectWakeCall(handler: ReturnType<typeof vi.fn>, index: number, request: WakeRequest) {
    const [actualRequest] = handler.mock.calls[index] ?? [];
    expect(actualRequest).toEqual(request);
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
    resetHeartbeatWakeStateForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preempts existing timer when a sooner schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    // Schedule for 5 seconds from now
    requestHeartbeat(wake("slow", { coalesceMs: 5000 }));

    // Schedule for 100ms from now — should preempt the 5s timer
    requestHeartbeat(wake("fast", { coalesceMs: 100 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    // The reason should be "fast" since it was set last
    expect(handler).toHaveBeenCalledWith(wake("fast"));
  });

  it("keeps existing timer when later schedule is requested", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    // Schedule for 100ms from now
    requestHeartbeat(wake("fast", { coalesceMs: 100 }));

    // Schedule for 5 seconds from now — should NOT preempt
    requestHeartbeat(wake("slow", { coalesceMs: 5000 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("clamps oversized coalesce delays instead of firing immediately", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("slow", { coalesceMs: Number.MAX_SAFE_INTEGER }));

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not downgrade a higher-priority pending reason", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("exec-event", { coalesceMs: 100 }));
    requestHeartbeat(wake("retry", { coalesceMs: 100 }));

    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(wake("exec-event"));
  });

  it("recovers interrupted wakes when a replacement handler is registered", async () => {
    vi.useFakeTimers();

    // Simulate a handler that's mid-execution when SIGUSR1 fires.
    // We do this by having the handler hang forever (never resolve).
    let resolveHang: () => void;
    const hangPromise = new Promise<void>((r) => {
      resolveHang = r;
    });
    const handlerA = vi
      .fn()
      .mockReturnValue(hangPromise.then(() => ({ status: "ran" as const, durationMs: 1 })));
    setHeartbeatWakeHandler(handlerA);

    // Trigger the handler — it starts running but never finishes
    const recovered = requestHeartbeatAndWait(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Now simulate SIGUSR1: register a new handler while handlerA is still running.
    // Without the fix, `running` would stay true and handlerB would never fire.
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    // The replacement must handle both the interrupted global barrier and fresh
    // targeted work. The recovered barrier runs first so the two cannot overlap.
    requestHeartbeat(wake("interval", { agentId: "ready", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB.mock.calls.map(([request]) => request.agentId)).toEqual([undefined, "ready"]);
    await expect(recovered).resolves.toEqual({ status: "ran", durationMs: 1 });

    // Clean up the hanging promise
    resolveHang!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not let a stale heartbeat lifecycle release a newer active wake", async () => {
    vi.useFakeTimers();
    let finishOldWake!: () => void;
    let finishNewWake!: () => void;
    const oldWakeFinished = new Promise<void>((resolve) => {
      finishOldWake = resolve;
    });
    const newWakeFinished = new Promise<void>((resolve) => {
      finishNewWake = resolve;
    });
    const oldHandler = vi.fn(async () => {
      await oldWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(oldHandler);
    requestHeartbeat(wake("interval", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(oldHandler).toHaveBeenCalledOnce();

    const newHandler = vi.fn(async (_request: WakeRequest) => {
      await newWakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(newHandler);
    requestHeartbeat(wake("interval", { agentId: "main", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(newHandler).toHaveBeenCalledOnce();

    finishOldWake();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    requestHeartbeat(wake("manual", { agentId: "main", coalesceMs: 25 }));
    await vi.advanceTimersByTimeAsync(25);
    expect(newHandler).toHaveBeenCalledOnce();

    finishNewWake();
    await vi.advanceTimersByTimeAsync(25);
    expect(newHandler).toHaveBeenCalledTimes(2);
    expect(newHandler.mock.calls[1]?.[0]).toMatchObject({
      intent: "manual",
      reason: "manual",
      agentId: "main",
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each([
    { outcome: "completed", expectedReasons: ["cron:job-a", "cron:job-b"] },
    { outcome: "thrown", expectedReasons: ["cron:job-a", "cron:job-b"] },
    { outcome: "busy", expectedReasons: ["cron:job-a", "cron:job-b"] },
    { outcome: "guarded", expectedReasons: ["cron:job-a", "cron:job-b"] },
  ] as const)(
    "hands off only unfinished wakes when a replaced handler is $outcome",
    async ({ outcome, expectedReasons }) => {
      vi.useFakeTimers();
      let finishOldWake!: () => void;
      const oldWakeFinished = new Promise<void>((resolve) => {
        finishOldWake = resolve;
      });
      const oldHandler = vi.fn(async () => {
        await oldWakeFinished;
        if (outcome === "thrown") {
          throw new Error("stale heartbeat target failed");
        }
        if (outcome === "busy") {
          return { status: "skipped" as const, reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT };
        }
        if (outcome === "guarded") {
          return {
            status: "skipped" as const,
            reason: "not-due",
            retryAtMs: Date.now() + 30 * 60_000,
          };
        }
        return { status: "ran" as const, durationMs: 1 };
      });
      setHeartbeatWakeHandler(oldHandler);

      for (const target of ["a", "b"]) {
        requestHeartbeat({
          source: "cron",
          intent: target === "a" ? "task" : "event",
          reason: `cron:job-${target}`,
          agentId: "main",
          sessionKey: "agent:main:main",
          coalesceMs: 100,
        });
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(oldHandler).toHaveBeenCalledOnce();

      const newHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setHeartbeatWakeHandler(newHandler);
      finishOldWake();
      await vi.advanceTimersByTimeAsync(250);

      expect(oldHandler).toHaveBeenCalledOnce();
      expect(newHandler.mock.calls.map(([request]) => request.reason)).toEqual(expectedReasons);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("does not let a stale disposer clear a newer handler", async () => {
    vi.useFakeTimers();
    const handlerA = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const disposeA = setHeartbeatWakeHandler(handlerA);
    setHeartbeatWakeHandler(handlerB);

    disposeA();
    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it("clears stale retry cooldown when a new handler is registered", async () => {
    vi.useFakeTimers();
    const handlerA = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
    setHeartbeatWakeHandler(handlerA);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerA).toHaveBeenCalledTimes(1);

    // Simulate SIGUSR1 startup with a fresh wake handler.
    const handlerB = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handlerB);

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledWith(wake("manual"));
  });

  it("forwards wake target fields and preserves them across retries", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();

    requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expectWakeCall(handler, 0, {
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    expectWakeCall(handler, 1, {
      source: "cron",
      intent: "immediate",
      reason: "cron:job-1",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });
  });

  it("preserves heartbeat override when same-target wakes coalesce", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      source: "manual",
      intent: "manual",
      reason: "manual",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      heartbeat: { target: "last" },
    });
  });

  it("executes distinct targeted wakes queued in the same coalescing window", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:job-a",
      agentId: "ops",
      sessionKey: "agent:ops:guildchat:channel:alerts",
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "cron",
      intent: "event",
      reason: "cron:job-b",
      agentId: "main",
      sessionKey: "agent:main:forum:group:-1001",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    const handledRequests = handler.mock.calls
      .map((call) => call[0])
      .toSorted((left, right) => left.reason.localeCompare(right.reason));
    expect(handledRequests).toEqual([
      {
        source: "cron",
        intent: "event",
        reason: "cron:job-a",
        agentId: "ops",
        sessionKey: "agent:ops:guildchat:channel:alerts",
      },
      {
        source: "cron",
        intent: "event",
        reason: "cron:job-b",
        agentId: "main",
        sessionKey: "agent:main:forum:group:-1001",
      },
    ]);
  });
});
