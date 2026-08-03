// Telegram tests cover polling status plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createTelegramPollingStatusPublisher } from "./polling-status.js";

describe("createTelegramPollingStatusPublisher", () => {
  it("publishes lifecycle at polling transition points", () => {
    const setStatus = vi.fn();
    const status = createTelegramPollingStatusPublisher(setStatus);

    status.notePollingStart();
    status.notePollSuccess(1234);
    status.notePollingRecovery();
    status.notePollingError("fetch failed", "recovering");
    status.notePollingError("unauthorized", "blocked");
    status.notePollingStop();

    expect(setStatus).toHaveBeenNthCalledWith(1, {
      mode: "polling",
      connected: false,
      lastConnectedAt: null,
      lastEventAt: null,
      lastTransportActivityAt: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(2, {
      mode: "polling",
      running: true,
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
      lastTransportActivityAt: 1234,
      lifecycle: "ready",
      terminalDisconnect: undefined,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(3, { lifecycle: "recovering" });
    expect(setStatus).toHaveBeenNthCalledWith(4, {
      mode: "polling",
      connected: false,
      lifecycle: "recovering",
      lastError: "fetch failed",
    });
    expect(setStatus).toHaveBeenNthCalledWith(5, {
      mode: "polling",
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "unauthorized",
    });
    expect(setStatus).toHaveBeenNthCalledWith(6, {
      mode: "polling",
      connected: false,
    });
  });
});
