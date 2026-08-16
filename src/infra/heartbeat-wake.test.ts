// Exercises heartbeat wake coalescing, retries, and skip handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  hasTrustedContinuationHeartbeatWake,
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatRaw as requestHeartbeat,
  requestHeartbeatNow,
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

  function trustedWake(reason: string, opts: Partial<WakeRequest> = {}): WakeRequest {
    return markTrustedContinuationHeartbeatWake(wake(reason, opts));
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

  async function expectRetryAfterDefaultDelay(params: {
    handler: ReturnType<typeof vi.fn>;
    initialReason: string;
    expectedRetryReason: string;
  }) {
    setHeartbeatWakeHandler(
      params.handler as unknown as Parameters<typeof setHeartbeatWakeHandler>[0],
    );
    requestHeartbeat(wake(params.initialReason, { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(1);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(params.handler).toHaveBeenCalledTimes(2);
    expectWakeCall(params.handler, 1, wake(params.expectedRetryReason));
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

  it("drains a pending wake once a handler is registered", async () => {
    vi.useFakeTimers();

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    setHeartbeatWakeHandler(handler);
    await vi.advanceTimersByTimeAsync(249);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(wake("manual"));
  });

  it("defers a full wake while gateway suspension is prepared", async () => {
    vi.useFakeTimers();
    const activeRootCounts: number[] = [];
    const handler = vi.fn(async () => {
      activeRootCounts.push(getActiveGatewayRootWorkCount());
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledOnce();
    expect(activeRootCounts).toEqual([1]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("counts an in-flight wake until the whole handler settles", async () => {
    vi.useFakeTimers();
    let finishWake: (() => void) | undefined;
    const wakeFinished = new Promise<void>((resolve) => {
      finishWake = resolve;
    });
    const handler = vi.fn(async () => {
      await wakeFinished;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("manual", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(suspension?.rollback()).toBe(true);

    finishWake?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("coalesces multiple wake requests into one highest-priority run", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { coalesceMs: 200 }));
    requestHeartbeat(wake("exec-event", { coalesceMs: 200 }));
    requestHeartbeat(wake("retry", { coalesceMs: 200 }));

    await vi.advanceTimersByTimeAsync(199);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(wake("exec-event"));
  });

  it("keeps trusted and untrusted same-priority wakes distinct when trusted arrives first", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(
      trustedWake("delegate-return", {
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );
    requestHeartbeat(
      wake("exec-event", {
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    const handled = handler.mock.calls
      .map(([request]) => ({
        reason: request.reason,
        trustedContinuationRouting: hasTrustedContinuationHeartbeatWake(request),
      }))
      .toSorted((left, right) => `${left.reason}`.localeCompare(`${right.reason}`));
    expect(handled).toEqual([
      { reason: "delegate-return", trustedContinuationRouting: true },
      { reason: "exec-event", trustedContinuationRouting: false },
    ]);
  });

  it("keeps trusted and untrusted same-priority wakes distinct when untrusted arrives first", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(
      wake("exec-event", {
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );
    requestHeartbeat(
      trustedWake("delegate-return", {
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    const handled = handler.mock.calls
      .map(([request]) => ({
        reason: request.reason,
        trustedContinuationRouting: hasTrustedContinuationHeartbeatWake(request),
      }))
      .toSorted((left, right) => `${left.reason}`.localeCompare(`${right.reason}`));
    expect(handled).toEqual([
      { reason: "delegate-return", trustedContinuationRouting: true },
      { reason: "exec-event", trustedContinuationRouting: false },
    ]);
  });

  it("does not let later higher-priority untrusted wakes erase trusted continuation wakes", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(
      trustedWake("delegate-return", {
        source: "other",
        intent: "event",
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );
    requestHeartbeat(
      wake("manual", {
        source: "manual",
        intent: "manual",
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      handler.mock.calls.some(
        ([request]) =>
          request.reason === "delegate-return" && hasTrustedContinuationHeartbeatWake(request),
      ),
    ).toBe(true);
    expect(
      handler.mock.calls.some(
        ([request]) => request.reason === "manual" && !hasTrustedContinuationHeartbeatWake(request),
      ),
    ).toBe(true);
  });

  it("does not let later higher-priority trusted wakes absorb untrusted wake reasons", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(
      wake("exec-event", {
        source: "exec-event",
        intent: "event",
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );
    requestHeartbeat(
      trustedWake("delegate-return", {
        source: "manual",
        intent: "immediate",
        agentId: "main",
        sessionKey: "agent:main:subagent:queue",
        coalesceMs: 100,
      }),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(
      handler.mock.calls.some(
        ([request]) =>
          request.reason === "exec-event" && !hasTrustedContinuationHeartbeatWake(request),
      ),
    ).toBe(true);
    expect(
      handler.mock.calls.some(
        ([request]) =>
          request.reason === "delegate-return" && hasTrustedContinuationHeartbeatWake(request),
      ),
    ).toBe(true);
  });

  it("preserves parent run id on wake delivery", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({ reason: "continuation", parentRunId: "run-parent", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "continuation",
        parentRunId: "run-parent",
      }),
    );
  });

  it("clears parent run id when a later same-target wake coalesces without one", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeatNow({ reason: "continuation", parentRunId: "run-parent", coalesceMs: 200 });
    requestHeartbeatNow({ reason: "continuation", coalesceMs: 200 });
    await vi.advanceTimersByTimeAsync(200);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "continuation",
      }),
    );
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("parentRunId");
  });

  it("coalesces independently scheduled tasks without dropping either prompt", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    for (const task of [
      { jobId: "job-inbox", name: "inbox", prompt: "Check inbox" },
      { jobId: "job-calendar", name: "calendar", prompt: "Check calendar" },
    ]) {
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${task.jobId}`,
        agentId: "main",
        tasks: [task],
        coalesceMs: 100,
      });
    }

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-calendar",
      agentId: "main",
      tasks: [
        { jobId: "job-calendar", name: "calendar", prompt: "Check calendar" },
        { jobId: "job-inbox", name: "inbox", prompt: "Check inbox" },
      ],
    });
  });

  it.each(["scheduled-first", "task-first"] as const)(
    "coalesces a colliding scheduled wake into the task turn (%s)",
    async (order) => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setHeartbeatWakeHandler(handler);
      const scheduled = wake("interval", {
        agentId: "main",
        scheduledEveryMs: 5 * 60_000,
        scheduledAnchorMs: 42_000,
        coalesceMs: 100,
      });
      const task = {
        source: "interval" as const,
        intent: "task" as const,
        reason: "heartbeat-task:job-inbox",
        agentId: "main",
        tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
        coalesceMs: 100,
      };

      for (const request of order === "scheduled-first" ? [scheduled, task] : [task, scheduled]) {
        requestHeartbeat(request);
      }
      await vi.advanceTimersByTimeAsync(100);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-inbox",
        agentId: "main",
        scheduledEveryMs: 5 * 60_000,
        scheduledAnchorMs: 42_000,
        tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      });
    },
  );

  it("runs a phase-aligned task on every period despite the min-spacing floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    let lastRunAtMs: number | undefined;
    const successfulTaskRuns: string[] = [];
    const handler = vi.fn().mockImplementation(async (request: WakeRequest) => {
      const now = Date.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < 30_000) {
        return { status: "skipped" as const, reason: "min-spacing" };
      }
      lastRunAtMs = now;
      if (request.intent === "task") {
        successfulTaskRuns.push(request.tasks?.[0]?.jobId ?? "missing");
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    const requestPeriod = () => {
      requestHeartbeat(wake("interval", { agentId: "main", coalesceMs: 100 }));
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-inbox",
        agentId: "main",
        tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
        coalesceMs: 100,
      });
    };

    requestPeriod();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(60_000);
    requestPeriod();
    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(successfulTaskRuns).toEqual(["job-inbox", "job-inbox"]);
  });

  it("keeps task and event wakes in separate guarded turns", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 100,
    });
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    const handledRequests = handler.mock.calls
      .map((call) => call[0])
      .toSorted((left, right) => left.intent.localeCompare(right.intent));
    expect(handledRequests).toEqual([
      {
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        agentId: "main",
      },
      {
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-inbox",
        agentId: "main",
        tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      },
    ]);
  });

  it("retains task prompts across busy retries", async () => {
    vi.useFakeTimers();
    const handler = setRetryOnceHeartbeatHandler();
    const request = {
      source: "interval" as const,
      intent: "task" as const,
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    };

    requestHeartbeat({ ...request, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, request);
    expect(handler).toHaveBeenNthCalledWith(2, { ...request, retainedWork: true });
  });

  it("runs equal-period tasks at staggered anchors by retaining the spaced task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    let lastRunAtMs: number | undefined;
    const successfulTaskRuns: string[] = [];
    const handler = vi.fn().mockImplementation(async (request: WakeRequest) => {
      const now = Date.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < 30_000) {
        return {
          status: "skipped" as const,
          reason: "min-spacing",
          retryAtMs: lastRunAtMs + 30_000,
        };
      }
      lastRunAtMs = now;
      successfulTaskRuns.push(...(request.tasks ?? []).map((task) => task.jobId));
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(25_000);

    await vi.advanceTimersByTimeAsync(29_999);
    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(4_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(successfulTaskRuns).toEqual(["job-a", "job-b", "job-a", "job-b"]);
  });

  it("does not starve an aged event behind repeated task turns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    let lastRunAtMs: number | undefined;
    const successfulIntents: WakeRequest["intent"][] = [];
    const handler = vi.fn().mockImplementation(async (request: WakeRequest) => {
      const now = Date.now();
      if (lastRunAtMs !== undefined && now - lastRunAtMs < 30_000) {
        return {
          status: "skipped" as const,
          reason: "min-spacing",
          retryAtMs: lastRunAtMs + 30_000,
        };
      }
      lastRunAtMs = now;
      successfulIntents.push(request.intent);
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(19_999);
    requestTask("job-b");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    requestTask("job-c");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(successfulIntents).toEqual(["task", "event", "task"]);
  });

  it("bounds merged task retry state and clears it after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    const requestTask = (jobId: string) =>
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: `heartbeat-task:${jobId}`,
        agentId: "main",
        tasks: [{ jobId, name: jobId, prompt: `Run ${jobId}` }],
        coalesceMs: 0,
      });

    requestTask("job-a");
    await vi.advanceTimersByTimeAsync(1);
    requestTask("job-b");
    requestTask("job-c");
    await vi.advanceTimersByTimeAsync(29_999);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0].tasks).toEqual([
      { jobId: "job-a", name: "job-a", prompt: "Run job-a" },
      { jobId: "job-b", name: "job-b", prompt: "Run job-b" },
      { jobId: "job-c", name: "job-c", prompt: "Run job-c" },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
    requestTask("job-d");
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]?.[0].tasks).toEqual([
      { jobId: "job-d", name: "job-d", prompt: "Run job-d" },
    ]);
  });

  it("does not let a retained event cooldown block independent task work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30 * 60_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });
  });

  it.each([
    { source: "manual" as const, intent: "manual" as const, reason: "manual" },
    { source: "cron" as const, intent: "immediate" as const, reason: "cron:job-now" },
  ])(
    "does not let a retained event cooldown defer an explicit $intent wake",
    async (explicitWake) => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000_000_000);
      const handler = vi
        .fn()
        .mockResolvedValueOnce({
          status: "skipped",
          reason: "not-due",
          retryAtMs: Date.now() + 30 * 60_000,
        })
        .mockResolvedValue({ status: "ran", durationMs: 1 });
      setHeartbeatWakeHandler(handler);

      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);

      requestHeartbeat({
        ...explicitWake,
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({
        ...explicitWake,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
    },
  );

  it("keeps a retained immediate wake guarded when an ordinary event joins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-now",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_997);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      source: "cron",
      intent: "immediate",
      reason: "cron:job-now",
    });
  });

  it.each([HEARTBEAT_SKIP_CRON_IN_PROGRESS])(
    "retries %s after the default retry delay",
    async (reason) => {
      vi.useFakeTimers();
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason })
        .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
      await expectRetryAfterDefaultDelay({
        handler,
        initialReason: "interval",
        expectedRetryReason: "interval",
      });
    },
  );

  it("lets a fresh event run while a scheduled retry observes idle grace", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);

    requestHeartbeat(wake("hook:wake", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expectWakeCall(handler, 1, wake("hook:wake"));

    await vi.advanceTimersByTimeAsync(59_998);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]?.[0]).toEqual({ ...wake("interval"), retainedWork: true });
  });

  it("retries thrown handler errors after the default retry delay", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "skipped", reason: "disabled" });
    await expectRetryAfterDefaultDelay({
      handler,
      initialReason: "exec-event",
      expectedRetryReason: "exec-event",
    });
  });

  it.each(["a", "b", "c"])(
    "retries only the failed targeted wake when batch target %s throws",
    async (failedTarget) => {
      vi.useFakeTimers();
      let hasFailed = false;
      const handler = vi.fn(async (request: WakeRequest) => {
        if (request.reason === `cron:job-${failedTarget}` && !hasFailed) {
          hasFailed = true;
          throw new Error("heartbeat target failed");
        }
        return { status: "ran" as const, durationMs: 1 };
      });
      setHeartbeatWakeHandler(handler);

      for (const target of ["a", "b", "c"]) {
        requestHeartbeat({
          source: "cron",
          intent: "event",
          reason: `cron:job-${target}`,
          agentId: `agent-${target}`,
          sessionKey: `agent:agent-${target}:main`,
          coalesceMs: 100,
        });
      }

      await vi.advanceTimersByTimeAsync(100);

      expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
        "cron:job-a",
        "cron:job-b",
        "cron:job-c",
      ]);
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(999);
      expect(handler).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
        "cron:job-a",
        "cron:job-b",
        "cron:job-c",
        `cron:job-${failedTarget}`,
      ]);
      expect(handler.mock.calls[3]?.[0]).toMatchObject({
        agentId: `agent-${failedTarget}`,
        sessionKey: `agent:agent-${failedTarget}:main`,
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("does not replay completed wake targets when another target keeps throwing", async () => {
    vi.useFakeTimers();
    let failedAttempts = 0;
    const handler = vi.fn(async (request: WakeRequest) => {
      if (request.reason === "cron:job-b" && failedAttempts < 2) {
        failedAttempts += 1;
        throw new Error("heartbeat target failed");
      }
      return { status: "ran" as const, durationMs: 1 };
    });
    setHeartbeatWakeHandler(handler);

    for (const target of ["a", "b", "c"]) {
      requestHeartbeat({
        source: "cron",
        intent: "event",
        reason: `cron:job-${target}`,
        agentId: `agent-${target}`,
        sessionKey: `agent:agent-${target}:main`,
        coalesceMs: 100,
      });
    }

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(handler.mock.calls.map(([request]) => request.reason)).toEqual([
      "cron:job-a",
      "cron:job-b",
      "cron:job-c",
      "cron:job-b",
      "cron:job-b",
    ]);
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
