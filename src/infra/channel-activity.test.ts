import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getChannelActivity,
  recordChannelActivity,
  resetChannelActivityForTest,
} from "./channel-activity.js";

describe("channel activity", () => {
  beforeEach(() => {
    resetChannelActivityForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records inbound/outbound separately", () => {
    recordChannelActivity({ channel: "telegram", direction: "inbound" });
    vi.advanceTimersByTime(1000);
    recordChannelActivity({ channel: "telegram", direction: "outbound" });
    const res = getChannelActivity({ channel: "telegram" });
    expect(res.inboundAt).toBe(1767830400000);
    expect(res.outboundAt).toBe(1767830401000);
  });

  it("isolates accounts", () => {
    recordChannelActivity({
      channel: "whatsapp",
      accountId: "a",
      direction: "inbound",
      at: 1,
    });
    recordChannelActivity({
      channel: "whatsapp",
      accountId: "b",
      direction: "inbound",
      at: 2,
    });
    expect(getChannelActivity({ channel: "whatsapp", accountId: "a" })).toEqual(
      {
        inboundAt: 1,
        outboundAt: null,
      },
    );
    expect(getChannelActivity({ channel: "whatsapp", accountId: "b" })).toEqual(
      {
        inboundAt: 2,
        outboundAt: null,
      },
    );
  });
});
