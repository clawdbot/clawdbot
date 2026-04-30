import { describe, expect, it, vi } from "vitest";
import { createTelegramWebhookStatusPublisher } from "./webhook-status.js";

describe("createTelegramWebhookStatusPublisher", () => {
  it("publishes start, advertised, update, failure, and stop status patches", () => {
    const setStatus = vi.fn();
    const status = createTelegramWebhookStatusPublisher(setStatus);

    status.noteWebhookStart();
    status.noteWebhookAdvertised(1234);
    status.noteWebhookUpdateReceived(2345);
    status.noteWebhookRegistrationFailure("fetch failed");
    status.noteWebhookStop();

    expect(setStatus).toHaveBeenNthCalledWith(1, {
      mode: "webhook",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastTransportActivityAt: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      mode: "webhook",
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(3, {
      mode: "webhook",
      connected: true,
      lastConnectedAt: 2345,
      lastEventAt: 2345,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(4, {
      mode: "webhook",
      connected: false,
      lastError: "fetch failed",
    });
    expect(setStatus).toHaveBeenNthCalledWith(5, {
      mode: "webhook",
      connected: false,
    });
  });
});
