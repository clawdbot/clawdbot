import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("heartbeat wake settlement", () => {
  let disposeHandler: (() => void) | undefined;

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      disposeHandler?.();
      disposeHandler = setHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    disposeHandler?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setHandler(handler: Parameters<typeof setHeartbeatWakeHandler>[0]) {
    disposeHandler = setHeartbeatWakeHandler(handler);
  }

  it("settles every caller represented by one coalesced wake", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const wake = { source: "interval" as const, intent: "scheduled" as const, reason: "interval" };
    const resultA = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });
    const resultB = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ ...wake, agentId: "main" });
    await expect(Promise.all([resultA, resultB])).resolves.toEqual([
      { status: "ran", durationMs: 7 },
      { status: "ran", durationMs: 7 },
    ]);
  });

  it("keeps an awaited cron wake pending across a retryable skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const result = requestHeartbeatAndWait({
      source: "cron",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("detaches an aborted waiter without cancelling its shared wake", async () => {
    vi.useFakeTimers();
    let finishChild: (() => void) | undefined;
    const child = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const handler = vi.fn(async () => {
      await child;
      return { status: "ran" as const, durationMs: 1 };
    });
    setHandler(handler);
    const controller = new AbortController();
    const result = requestHeartbeatAndWait(
      { source: "interval", intent: "scheduled", reason: "interval", coalesceMs: 0 },
      { abortSignal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "heartbeat wake cancelled",
    });

    finishChild?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
  });
});
