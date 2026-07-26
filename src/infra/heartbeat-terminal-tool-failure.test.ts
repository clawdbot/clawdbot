import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { handleHeartbeatTerminalToolFailure } from "./heartbeat-terminal-tool-failure.js";

describe("handleHeartbeatTerminalToolFailure", () => {
  afterEach(() => resetHeartbeatEventsForTest());

  it("preserves terminal tool-failure status when channel readiness rejects", async () => {
    const readinessError = new Error("readiness probe failed");
    const deliver = vi.fn();
    const onDeliveryError = vi.fn();

    await expect(
      handleHeartbeatTerminalToolFailure({
        failure: { toolName: "message" },
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
    ).resolves.toEqual({ status: "failed", reason: "agent-tool-failure" });

    expect(deliver).not.toHaveBeenCalled();
    expect(onDeliveryError).toHaveBeenCalledWith(readinessError);
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "failed",
      reason: "agent-tool-failure",
      channel: "whatsapp",
      silent: true,
    });
  });
});
