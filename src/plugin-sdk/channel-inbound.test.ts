import { describe, expect, it } from "vitest";
import { buildChannelTurnContext, type BuildChannelTurnContextParams } from "./channel-inbound.js";

function createLegacyTurnParams(
  overrides: Partial<BuildChannelTurnContextParams> = {},
): BuildChannelTurnContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
      routePeer: { kind: "group", id: "room-1" },
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
      originatingTo: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      envelopeFrom: "User One",
      inboundTurnKind: "room_event",
    },
    ...overrides,
  };
}

describe("channel-inbound public compatibility helpers", () => {
  it("maps legacy buildChannelTurnContext inboundTurnKind into inbound event context", () => {
    const ctx = buildChannelTurnContext(createLegacyTurnParams());

    expect(ctx.InboundEventKind).toBe("room_event");
    expect(ctx.InboundTurnKind).toBe("room_event");
  });
});
