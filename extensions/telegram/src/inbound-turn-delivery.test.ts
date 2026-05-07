import { describe, expect, it } from "vitest";
import {
  beginTelegramInboundTurnDeliveryCorrelation,
  notifyTelegramInboundTurnOutboundSuccess,
} from "./inbound-turn-delivery.js";

describe("telegram inbound turn delivery", () => {
  it("marks delivered once for a matching outbound send then clears correlation", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:z", {
      outboundTo: "999",
      outboundAccountId: "a1",
      markInboundTurnDelivered: () => {
        count += 1;
      },
    });
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:z",
      to: "999",
      accountId: "a1",
    });
    expect(count).toBe(1);
    end();
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:z",
      to: "999",
      accountId: "a1",
    });
    expect(count).toBe(1);
  });

  it("ignores outbound sends to another destination", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:y", {
      outboundTo: "1",
      markInboundTurnDelivered: () => {
        count += 1;
      },
    });
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:y",
      to: "2",
      accountId: undefined,
    });
    expect(count).toBe(0);
    end();
  });
});
