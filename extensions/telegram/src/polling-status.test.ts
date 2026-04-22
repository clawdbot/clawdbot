import { describe, expect, it, vi } from "vitest";
import { createTelegramPollingStatusPublisher } from "./polling-status.js";

describe("createTelegramPollingStatusPublisher", () => {
  it("publishes start, successful poll, and stop status patches", () => {
    const setStatus = vi.fn();
    const status = createTelegramPollingStatusPublisher(setStatus);

    status.notePollingStart();
    status.notePollSuccess(1234);
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
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
      lastTransportActivityAt: 1234,
      lastError: null,
    });
    expect(setStatus).toHaveBeenNthCalledWith(3, {
      mode: "polling",
      connected: false,
    });
  });
});
