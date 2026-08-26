import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat wake preemption retry", () => {
  type HeartbeatWakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  let disposeHandler: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: HeartbeatWakeHandler) {
    disposeHandler = setRuntimeHeartbeatWakeHandler(handler);
  }

  function wake(reason: "interval" | "manual" | "exec-event", opts: Partial<WakeRequest> = {}) {
    const source =
      reason === "interval" ? "interval" : reason === "manual" ? "manual" : "exec-event";
    const intent = reason === "interval" ? "scheduled" : reason === "manual" ? "manual" : "event";
    return { source, intent, reason, ...opts } satisfies WakeRequest;
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    disposeHandler?.();
    const disposeDrain = setRuntimeHeartbeatWakeHandler(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    await vi.runAllTimersAsync();
    disposeDrain();
    disposeHandler = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([-86_400_000, 86_400_000])(
    "dispatches a coalesced wake after the wall clock changes by %i ms",
    async (clockChangeMs) => {
      vi.setSystemTime(2_000_000_000_000);
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      setHeartbeatWakeHandler(handler);

      requestHeartbeat(wake("manual", { coalesceMs: 250 }));
      vi.setSystemTime(Date.now() + clockChangeMs);
      await vi.advanceTimersByTimeAsync(249);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledExactlyOnceWith(wake("manual"));
    },
  );

  it("dispatches an urgent wake after the wall clock changes forward", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("interval", { agentId: "slow", coalesceMs: 60_000 }));
    vi.setSystemTime(Date.now() + 3_600_000);
    requestHeartbeat(wake("manual", { agentId: "urgent", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler).toHaveBeenCalledExactlyOnceWith(wake("manual", { agentId: "urgent" }));
  });

  it("retries a retained wake on time after the wall clock changes", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "min-spacing",
        retryAtMs: Date.now() + 1_000,
      })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);

    requestHeartbeat(wake("exec-event", { coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() - 86_400_000);
    await vi.advanceTimersByTimeAsync(998);
    expect(handler).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("hands a suspended wake to the replacement without running the retired handler", async () => {
    const retiredHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const replacementHandler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(retiredHandler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const pendingWake = {
      source: "cron" as const,
      intent: "event" as const,
      reason: "cron:retired-generation",
      agentId: "main",
    };
    requestHeartbeat({ ...pendingWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    setHeartbeatWakeHandler(replacementHandler);
    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(replacementHandler).toHaveBeenCalledExactlyOnceWith(pendingWake);
  });

  it("gives scheduled requests-in-flight a 60-second idle grace", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat(wake("interval", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toEqual({ ...wake("interval"), retainedWork: true });
  });

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat(wake("manual", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("retries preempted task work after idle grace without losing its payload", async () => {
    const tasks = [{ jobId: "job-backup", name: "backup", prompt: "Check backup" }];
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "preempted" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat({
      source: "background-task",
      intent: "task",
      reason: "heartbeat-task:job-backup",
      agentId: "main",
      sessionKey: "agent:main:main",
      tasks,
      coalesceMs: 0,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ tasks, retainedWork: true });
  });

  it("lets a fresh manual wake bypass a scheduled idle grace", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:main" };
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat(wake("interval", { ...target, coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    requestHeartbeat(wake("manual", { ...target, coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls[1]?.[0]).toEqual(wake("manual", target));

    await vi.advanceTimersByTimeAsync(59_998);
    expect(handler.mock.calls[2]?.[0]).toEqual({
      ...wake("interval", target),
      retainedWork: true,
    });
  });

  it("keeps guarded event work retained through preemption", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "not-due",
        retryAtMs: Date.now() + 30_000,
      })
      .mockResolvedValueOnce({ status: "skipped", reason: "preempted" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHeartbeatWakeHandler(handler);
    requestHeartbeat(wake("exec-event", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ retainedWork: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler.mock.calls[2]?.[0]).toMatchObject({ retainedWork: true });
  });
});
