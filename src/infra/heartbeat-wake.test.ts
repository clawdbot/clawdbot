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
  requestHeartbeat,
  requestHeartbeatAndWait,
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
