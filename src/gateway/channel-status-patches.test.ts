/**
 * Channel status patching tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "./channel-status-patches.js";

describe("createConnectedChannelStatusPatch", () => {
  it("uses one timestamp for connected event-liveness state", () => {
    expect(createConnectedChannelStatusPatch(1234)).toEqual({
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
    });
  });
});

describe("createTransportActivityStatusPatch", () => {
  it("reports transport liveness without implying a new connection event", () => {
    expect(createTransportActivityStatusPatch(1234)).toEqual({
      lastTransportActivityAt: 1234,
    });
  });
});

describe("channel lifecycle status patches", () => {
  it("creates a ready patch that clears retained terminal state", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      expect(channelReadyPatch({ mode: "polling" })).toEqual({
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: 1234,
        lastError: null,
        terminalDisconnect: undefined,
        mode: "polling",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("creates a blocked patch with the required error and channel extras", () => {
    expect(channelBlockedPatch("invalid token", { connected: false })).toEqual({
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "invalid token",
      connected: false,
    });
  });

  it("creates a stopped patch and applies extras after the shared base", () => {
    expect(channelStoppedPatch({ lastStopAt: 1234 })).toEqual({
      running: false,
      connected: false,
      lifecycle: "stopped",
      lastStopAt: 1234,
    });
  });
});
