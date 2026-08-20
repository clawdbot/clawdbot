import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { handleHeartbeatFailureNotice } from "./heartbeat-failure-notice.js";

describe("handleHeartbeatFailureNotice", () => {
  afterEach(() => resetHeartbeatEventsForTest());

  it.each(["agent-tool-failure", "agent-runner-failure"] as const)(
    "preserves %s status when channel readiness rejects",
    async (reason) => {
      const readinessError = new Error("readiness probe failed");
      const deliver = vi.fn();
      const onDeliveryError = vi.fn();

      await expect(
        handleHeartbeatFailureNotice({
          reason,
          previewText: "message",
          normalized: {
            shouldSkip: false,
            text: "Message delivery failed.",
            hasMedia: false,
            isInternalPlaceholderOnly: false,
          },
          shouldSkipMain: false,
          delivery: { channel: "whatsapp", to: "+15555550100" },
          showAlerts: true,
          useIndicator: false,
          startedAt: Date.now(),
          preview: (value) => value,
          restoreUpdatedAt: async () => undefined,
          checkReady: async () => {
            throw readinessError;
          },
          deliver,
          onDeliveryError,
          clearSatisfiedPendingFinalDelivery: async () => undefined,
          onChannelNotReady: vi.fn(),
        }),
      ).resolves.toEqual({ status: "failed", reason });

      expect(deliver).not.toHaveBeenCalled();
      expect(onDeliveryError).toHaveBeenCalledWith(readinessError);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "failed",
        reason,
        channel: "whatsapp",
        silent: true,
      });
    },
  );

  it.each([
    { deliveryStatus: "sent" as const, expectedClears: 1 },
    { deliveryStatus: "suppressed" as const, expectedClears: 0 },
  ])("clears satisfied recovery only after $deliveryStatus delivery", async (testCase) => {
    const clearSatisfiedPendingFinalDelivery = vi.fn();

    await expect(
      handleHeartbeatFailureNotice({
        reason: "agent-runner-failure",
        normalized: {
          shouldSkip: false,
          text: "Agent turn failed.",
          hasMedia: false,
          isInternalPlaceholderOnly: false,
        },
        shouldSkipMain: false,
        delivery: { channel: "telegram", to: "chat" },
        showAlerts: true,
        useIndicator: false,
        startedAt: Date.now(),
        preview: (value) => value,
        restoreUpdatedAt: async () => undefined,
        deliver: async () => testCase.deliveryStatus,
        clearSatisfiedPendingFinalDelivery,
        onChannelNotReady: vi.fn(),
      }),
    ).resolves.toEqual({ status: "failed", reason: "agent-runner-failure" });

    expect(clearSatisfiedPendingFinalDelivery).toHaveBeenCalledTimes(testCase.expectedClears);
  });
});
