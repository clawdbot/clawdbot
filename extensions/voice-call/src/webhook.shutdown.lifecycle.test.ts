import { describe, expect, it, vi } from "vitest";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

describe("VoiceCallWebhookServer shutdown lifecycle", () => {
  it("waits for owned handlers and shares concurrent stop completion", async () => {
    let releaseHandlerClose: (() => void) | undefined;
    const handlerClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseHandlerClose = resolve;
        }),
    );
    const delayedHangup = vi.fn(async () => ({ success: true }));
    const server = new VoiceCallWebhookServer(
      createVoiceCallBaseConfig({ tunnelProvider: "none" }),
      {
        getCallByProviderCallId: vi.fn(() => ({ callId: "call-1" })),
        endCall: delayedHangup,
      } as unknown as CallManager,
      {} as VoiceCallProvider,
    );
    server.setRealtimeHandler({
      close: handlerClose,
    } as unknown as RealtimeCallHandler);
    await server.start();
    vi.useFakeTimers();
    const streamLifecycle = server.getStreamDisconnectLifecycle();
    streamLifecycle.connect("provider-call", "stream-1");
    streamLifecycle.disconnect("provider-call", "stream-1");

    const firstStop = server.stop();
    const secondStop = server.stop();
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });

    try {
      expect(secondStop).toBe(firstStop);
      expect(handlerClose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_100);
      expect(stopped).toBe(false);
      expect(delayedHangup).not.toHaveBeenCalled();
    } finally {
      releaseHandlerClose?.();
      await firstStop;
      vi.useRealTimers();
    }
    expect(stopped).toBe(true);
  });
});
