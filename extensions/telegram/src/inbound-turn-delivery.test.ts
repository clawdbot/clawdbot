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

  it("matches provider-prefixed Telegram targets for delivery correlation", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:prefixed", {
      outboundTo: "-100123",
      markInboundTurnDelivered: () => {
        count += 1;
      },
    });

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:prefixed",
      to: "telegram:-100123",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches Telegram topic targets by conversation for delivery correlation", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("sess:topic", {
      outboundTo: "-100123",
      markInboundTurnDelivered: () => {
        count += 1;
      },
    });

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:topic",
      to: "telegram:-100123:topic:77",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches legacy Telegram group targets for delivery correlation", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation(
      "sess:legacy-group",
      {
        outboundTo: "-100123",
        markInboundTurnDelivered: () => {
          count += 1;
        },
      },
      { inboundTurnKind: "room_event" },
    );

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:legacy-group",
      to: "telegram:group:-100123:topic:77",
      inboundTurnKind: "room_event",
    });

    expect(count).toBe(1);
    end();
  });

  it("keeps topic-scoped delivery correlations topic-specific", () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation(
      "sess:topic-specific",
      {
        outboundTo: "telegram:group:-100123:topic:77",
        markInboundTurnDelivered: () => {
          count += 1;
        },
      },
      { inboundTurnKind: "room_event" },
    );

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:88",
      inboundTurnKind: "room_event",
    });
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123",
      inboundTurnKind: "room_event",
    });

    expect(count).toBe(0);
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:77",
      inboundTurnKind: "room_event",
    });
    expect(count).toBe(1);
    end();
  });

  it("keeps user-request and room-event delivery correlations separate", () => {
    let userRequestCount = 0;
    let roomEventCount = 0;
    const endUserRequest = beginTelegramInboundTurnDeliveryCorrelation("sess:x", {
      outboundTo: "999",
      markInboundTurnDelivered: () => {
        userRequestCount += 1;
      },
    });
    const endRoomEvent = beginTelegramInboundTurnDeliveryCorrelation(
      "sess:x",
      {
        outboundTo: "999",
        markInboundTurnDelivered: () => {
          roomEventCount += 1;
        },
      },
      { inboundTurnKind: "room_event" },
    );

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:x",
      to: "999",
      inboundTurnKind: "room_event",
    });
    expect(roomEventCount).toBe(1);
    expect(userRequestCount).toBe(0);

    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:x",
      to: "999",
    });
    expect(roomEventCount).toBe(1);
    expect(userRequestCount).toBe(1);

    endRoomEvent();
    endUserRequest();
  });

  it("keeps a newer overlapping room-event correlation when an older one ends", () => {
    let firstCount = 0;
    let secondCount = 0;
    const endFirst = beginTelegramInboundTurnDeliveryCorrelation(
      "sess:overlap",
      {
        outboundTo: "999",
        markInboundTurnDelivered: () => {
          firstCount += 1;
        },
      },
      { inboundTurnKind: "room_event" },
    );
    const endSecond = beginTelegramInboundTurnDeliveryCorrelation(
      "sess:overlap",
      {
        outboundTo: "999",
        markInboundTurnDelivered: () => {
          secondCount += 1;
        },
      },
      { inboundTurnKind: "room_event" },
    );

    endFirst();
    notifyTelegramInboundTurnOutboundSuccess({
      sessionKey: "sess:overlap",
      to: "999",
      inboundTurnKind: "room_event",
    });

    expect(firstCount).toBe(0);
    expect(secondCount).toBe(1);
    endSecond();
  });
});
