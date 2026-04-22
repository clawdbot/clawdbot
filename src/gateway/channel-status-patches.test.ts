import { describe, expect, it } from "vitest";
import {
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
