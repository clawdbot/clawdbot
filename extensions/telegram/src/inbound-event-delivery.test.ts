// Telegram tests cover inbound event delivery plugin behavior.
import { describe, expect, it } from "vitest";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

describe("telegram inbound event delivery", () => {
  it("marks delivered once for a matching outbound send then clears correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:z", {
      outboundTo: "999",
      outboundAccountId: "a1",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:z",
      to: "999",
      accountId: "a1",
    });
    expect(count).toBe(1);
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:z",
      to: "999",
      accountId: "a1",
    });
    expect(count).toBe(1);
    end();
  });

  it("ignores outbound sends to another destination", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:y", {
      outboundTo: "1",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:y",
      to: "2",
      accountId: undefined,
    });
    expect(count).toBe(0);
    end();
  });

  it("releases correlation before a failing delivery marker runs", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:throws", {
      outboundTo: "999",
      markInboundEventDelivered: () => {
        count += 1;
        throw new Error("marker failed");
      },
    });

    expect(() =>
      telegramInboundEventDelivery.notify({ sessionKey: "sess:throws", to: "999" }),
    ).toThrow("marker failed");
    expect(() =>
      telegramInboundEventDelivery.notify({ sessionKey: "sess:throws", to: "999" }),
    ).not.toThrow();
    expect(count).toBe(1);
    end();
  });

  it("matches provider-prefixed Telegram targets for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:prefixed", {
      outboundTo: "-100123",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:prefixed",
      to: "telegram:-100123",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches Telegram topic targets by conversation for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin("sess:topic", {
      outboundTo: "-100123",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic",
      to: "telegram:-100123:topic:77",
    });

    expect(count).toBe(1);
    end();
  });

  it("matches legacy Telegram group targets for delivery correlation", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin(
      "sess:legacy-group",
      {
        outboundTo: "-100123",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:legacy-group",
      to: "telegram:group:-100123:topic:77",
      inboundEventKind: "room_event",
    });

    expect(count).toBe(1);
    end();
  });

  it("keeps topic-scoped delivery correlations topic-specific", () => {
    let count = 0;
    const end = telegramInboundEventDelivery.begin(
      "sess:topic-specific",
      {
        outboundTo: "telegram:group:-100123:topic:77",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:88",
      inboundEventKind: "room_event",
    });
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123",
      inboundEventKind: "room_event",
    });

    expect(count).toBe(0);
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:topic-specific",
      to: "telegram:group:-100123:topic:77",
      inboundEventKind: "room_event",
    });
    expect(count).toBe(1);
    end();
  });

  it("keeps user-request and room-event delivery correlations separate", () => {
    let userRequestCount = 0;
    let roomEventCount = 0;
    const endUserRequest = telegramInboundEventDelivery.begin("sess:x", {
      outboundTo: "999",
      markInboundEventDelivered: () => {
        userRequestCount += 1;
      },
    });
    const endRoomEvent = telegramInboundEventDelivery.begin(
      "sess:x",
      {
        outboundTo: "999",
        markInboundEventDelivered: () => {
          roomEventCount += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    telegramInboundEventDelivery.notify({
      sessionKey: "sess:x",
      to: "999",
      inboundEventKind: "room_event",
    });
    expect(roomEventCount).toBe(1);
    expect(userRequestCount).toBe(0);

    telegramInboundEventDelivery.notify({
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
    const endFirst = telegramInboundEventDelivery.begin(
      "sess:overlap",
      {
        outboundTo: "999",
        markInboundEventDelivered: () => {
          firstCount += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );
    const endSecond = telegramInboundEventDelivery.begin(
      "sess:overlap",
      {
        outboundTo: "999",
        markInboundEventDelivered: () => {
          secondCount += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    endFirst();
    telegramInboundEventDelivery.notify({
      sessionKey: "sess:overlap",
      to: "999",
      inboundEventKind: "room_event",
    });

    expect(firstCount).toBe(0);
    expect(secondCount).toBe(1);
    endSecond();
  });
});
