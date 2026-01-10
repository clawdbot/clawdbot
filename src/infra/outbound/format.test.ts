import { describe, expect, it } from "vitest";

import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "./format.js";

describe("formatOutboundDeliverySummary", () => {
  it("falls back when result is missing", () => {
    expect(formatOutboundDeliverySummary("telegram")).toBe(
      "✅ Sent via Telegram. Message ID: unknown",
    );
    expect(formatOutboundDeliverySummary("imessage")).toBe(
      "✅ Sent via iMessage. Message ID: unknown",
    );
  });

  it("adds chat or channel details", () => {
    expect(
      formatOutboundDeliverySummary("telegram", {
        provider: "telegram",
        messageId: "m1",
        chatId: "c1",
      }),
    ).toBe("✅ Sent via Telegram. Message ID: m1 (chat c1)");

    expect(
      formatOutboundDeliverySummary("discord", {
        provider: "discord",
        messageId: "d1",
        channelId: "chan",
      }),
    ).toBe("✅ Sent via Discord. Message ID: d1 (channel chan)");
  });
});

describe("buildOutboundDeliveryJson", () => {
  it("builds direct delivery payloads", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "telegram",
        to: "123",
        result: { provider: "telegram", messageId: "m1", chatId: "c1" },
        mediaUrl: "https://example.com/a.png",
      }),
    ).toEqual({
      provider: "telegram",
      via: "direct",
      to: "123",
      messageId: "m1",
      mediaUrl: "https://example.com/a.png",
      chatId: "c1",
    });
  });

  it("supports whatsapp metadata when present", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "whatsapp",
        to: "+1",
        result: { provider: "whatsapp", messageId: "w1", toJid: "jid" },
      }),
    ).toEqual({
      provider: "whatsapp",
      via: "direct",
      to: "+1",
      messageId: "w1",
      mediaUrl: null,
      toJid: "jid",
    });
  });

  it("keeps timestamp for signal", () => {
    expect(
      buildOutboundDeliveryJson({
        provider: "signal",
        to: "+1",
        result: { provider: "signal", messageId: "s1", timestamp: 123 },
      }),
    ).toEqual({
      provider: "signal",
      via: "direct",
      to: "+1",
      messageId: "s1",
      mediaUrl: null,
      timestamp: 123,
    });
  });
});

describe("formatGatewaySummary", () => {
  it("formats gateway summaries with provider", () => {
    expect(
      formatGatewaySummary({ provider: "whatsapp", messageId: "m1" }),
    ).toBe("✅ Sent via gateway (whatsapp). Message ID: m1");
  });

  it("supports custom actions", () => {
    expect(
      formatGatewaySummary({
        action: "Poll sent",
        provider: "discord",
        messageId: "p1",
      }),
    ).toBe("✅ Poll sent via gateway (discord). Message ID: p1");
  });
});
