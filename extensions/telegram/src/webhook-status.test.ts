// Telegram tests cover webhook status plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createTelegramWebhookStatusPublisher } from "./webhook-status.js";

describe("createTelegramWebhookStatusPublisher", () => {
  it("publishes lifecycle at webhook transition points", () => {
    const setStatus = vi.fn();
    const status = createTelegramWebhookStatusPublisher(setStatus);

    status.noteWebhookStart();
    status.noteWebhookAdvertised(1234);
    status.noteWebhookUpdateReceived(2345);
    status.noteWebhookRecovery();
    status.noteWebhookRegistrationFailure("fetch failed", "recovering");
    status.noteWebhookRegistrationFailure("unauthorized", "blocked");
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
      running: true,
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(3, {
      mode: "webhook",
      running: true,
      connected: true,
      lastConnectedAt: 2345,
      lastEventAt: 2345,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(4, { lifecycle: "recovering" });
    expect(setStatus).toHaveBeenNthCalledWith(5, {
      mode: "webhook",
      connected: false,
      lifecycle: "recovering",
      lastError: "fetch failed",
    });
    expect(setStatus).toHaveBeenNthCalledWith(6, {
      mode: "webhook",
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "unauthorized",
    });
    expect(setStatus).toHaveBeenNthCalledWith(7, {
      mode: "webhook",
      connected: false,
    });
  });
});
