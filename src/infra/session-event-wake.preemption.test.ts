import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler as setRuntimeSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("session event wake preemption retry", () => {
  type SessionEventWakeHandler = Parameters<typeof setRuntimeSessionEventWakeHandler>[0];
  type WakeRequest = Parameters<typeof requestSessionEventWake>[0];
  let disposeHandler: (() => void) | undefined;

  function setSessionEventWakeHandler(handler: SessionEventWakeHandler) {
    disposeHandler = setRuntimeSessionEventWakeHandler(handler);
  }

  function wake(reason: "manual" | "exec-event", opts: Partial<WakeRequest> = {}) {
    const source = reason === "manual" ? "manual" : "exec-event";
    const intent = reason === "manual" ? "manual" : "event";
    return { source, intent, reason, ...opts } satisfies WakeRequest;
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    disposeHandler?.();
    const disposeDrain = setRuntimeSessionEventWakeHandler(async () => ({
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
      setSessionEventWakeHandler(handler);

      requestSessionEventWake(wake("manual", { coalesceMs: 250 }));
      vi.setSystemTime(Date.now() + clockChangeMs);
      await vi.advanceTimersByTimeAsync(249);
      expect(handler).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(handler.mock.calls.map(([request]) => request)).toEqual([wake("manual")]);
    },
  );

  it("dispatches an urgent wake after the wall clock changes forward", async () => {
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);

    requestSessionEventWake(wake("exec-event", { agentId: "slow", coalesceMs: 60_000 }));
    vi.setSystemTime(Date.now() + 3_600_000);
    requestSessionEventWake(wake("manual", { agentId: "urgent", coalesceMs: 0 }));
    await vi.advanceTimersByTimeAsync(1);

    expect(handler.mock.calls.map(([request]) => request)).toEqual([
      wake("manual", { agentId: "urgent" }),
    ]);
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
    setSessionEventWakeHandler(handler);

    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));
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
    setSessionEventWakeHandler(retiredHandler);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const pendingWake = {
      source: "cron" as const,
      intent: "event" as const,
      reason: "cron:retired-generation",
      agentId: "main",
    };
    requestSessionEventWake({ ...pendingWake, coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);
    setSessionEventWakeHandler(replacementHandler);
    expect(suspension?.release()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);

    expect(retiredHandler).not.toHaveBeenCalled();
    expect(replacementHandler.mock.calls.map(([request]) => request)).toEqual([pendingWake]);
  });

  it.each(
    ["replace", "dispose"].flatMap((change) => [false, true].map((throws) => ({ change, throws }))),
  )(
    "hands an entire ready batch to its next owner after synchronous $change (throws=$throws)",
    async ({ change, throws }) => {
      const replacement = vi.fn(async () => ({ status: "ran" as const, durationMs: 7 }));
      const retired = vi.fn(() => {
        if (retired.mock.calls.length === 1) {
          if (change === "replace") {
            setSessionEventWakeHandler(replacement);
          } else {
            disposeHandler?.();
          }
        }
        if (throws) {
          throw new Error("Retired handler failed synchronously");
        }
        return new Promise<never>(() => {});
      });
      setSessionEventWakeHandler(retired);
      const results = ["first", "second", "third"].map((agentId) =>
        requestSessionEventWakeAndWait(wake("exec-event", { agentId, coalesceMs: 0 })),
      );

      await vi.advanceTimersByTimeAsync(1);
      expect(retired).toHaveBeenCalledOnce();
      if (change === "dispose") {
        expect(replacement).not.toHaveBeenCalled();
        setSessionEventWakeHandler(replacement);
      }
      await vi.runAllTimersAsync();

      expect(replacement).toHaveBeenCalledTimes(3);
      expect(await Promise.all(results)).toEqual([
        { status: "ran", durationMs: 7 },
        { status: "ran", durationMs: 7 },
        { status: "ran", durationMs: 7 },
      ]);
    },
  );

  it("keeps manual requests-in-flight on the default retry delay", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: "active-run" })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setSessionEventWakeHandler(handler);
    requestSessionEventWake(wake("manual", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each(["preempted", "channel-not-ready"])(
    "retries %s event work after idle grace without losing its target",
    async (reason) => {
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ status: "skipped", reason })
        .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
      setSessionEventWakeHandler(handler);
      requestSessionEventWake({
        source: "background-task",
        intent: "event",
        reason: "background-task:job-backup",
        agentId: "main",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(handler).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({
        sessionKey: "agent:main:main",
        retainedWork: true,
      });
    },
  );

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
    setSessionEventWakeHandler(handler);
    requestSessionEventWake(wake("exec-event", { coalesceMs: 0 }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ retainedWork: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler.mock.calls[2]?.[0]).toMatchObject({ retainedWork: true });
  });
});
