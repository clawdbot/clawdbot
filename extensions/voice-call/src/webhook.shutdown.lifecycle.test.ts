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
    const server = new VoiceCallWebhookServer(
      createVoiceCallBaseConfig({ tunnelProvider: "none" }),
      {} as CallManager,
      {} as VoiceCallProvider,
    );
    server.setRealtimeHandler({
      close: handlerClose,
    } as unknown as RealtimeCallHandler);
    await server.start();
    const delayedHangup = vi.fn();
    const pendingDisconnectHangups = (
      server as unknown as {
        pendingDisconnectHangups: Map<string, unknown>;
      }
    ).pendingDisconnectHangups;
    pendingDisconnectHangups.set("provider-call", setTimeout(delayedHangup, 5));

    const firstStop = server.stop();
    const secondStop = server.stop();
    let stopped = false;
    void firstStop.then(() => {
      stopped = true;
    });

    try {
      expect(secondStop).toBe(firstStop);
      expect(handlerClose).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(stopped).toBe(false);
      expect(delayedHangup).not.toHaveBeenCalled();
    } finally {
      releaseHandlerClose?.();
      await firstStop;
    }
    expect(stopped).toBe(true);
  });
});
