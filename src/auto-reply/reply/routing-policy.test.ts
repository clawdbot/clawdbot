import { describe, expect, it } from "vitest";
import { resolveReplyRoutingDecision } from "./routing-policy.js";

function isRoutableChannel(channel: string | undefined) {
  return Boolean(
    channel &&
    ["telegram", "slack", "discord", "signal", "imessage", "whatsapp", "feishu"].includes(channel),
  );
}

describe("resolveReplyRoutingDecision", () => {
  it("routes replies to the originating channel when the current provider differs", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "slack",
        surface: "slack",
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      currentSurface: "slack",
      isInternalWebchatTurn: false,
      shouldRouteToOriginating: true,
      shouldSuppressTyping: true,
    });
  });

  it("does not route external replies from internal webchat without explicit delivery", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "webchat",
        surface: "webchat",
        explicitDeliverRoute: false,
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      currentSurface: "webchat",
      isInternalWebchatTurn: true,
      shouldRouteToOriginating: false,
      shouldSuppressTyping: false,
    });
  });

  it("suppresses direct user delivery for parent-owned background ACP children", () => {
    expect(
      resolveReplyRoutingDecision({
        provider: "discord",
        surface: "discord",
        originatingChannel: "telegram",
        originatingTo: "telegram:123",
        suppressDirectUserDelivery: true,
        isRoutableChannel,
      }),
    ).toEqual({
      originatingChannel: "telegram",
      currentSurface: "discord",
      isInternalWebchatTurn: false,
      shouldRouteToOriginating: false,
      shouldSuppressTyping: true,
    });
  });
});
