/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type PluginHookChannelSenderContext,
} from "./channel-inbound.js";

declare module "./channel-inbound.js" {
  interface PluginHookChannelSenderContext {
    testUnionId?: string;
  }
}

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      inboundEventKind: "room_event",
    },
    ...overrides,
  };
}

describe("channel-inbound public helpers", () => {
  it("builds inbound event kind into message context", async () => {
    const ctx = buildChannelInboundEventContext(createInboundParams());

    expect(ctx.InboundEventKind).toBe("room_event");
  });

  it("accepts plugin-augmented hook channel sender fields", () => {
    expectTypeOf<PluginHookChannelSenderContext["testUnionId"]>().toEqualTypeOf<
      string | undefined
    >();
    const sender = {
      id: "u1",
      testUnionId: "union-1",
    } satisfies PluginHookChannelSenderContext;
    expect(sender.testUnionId).toBe("union-1");
    const channelContext = {
      sender: {
        id: "u1",
        testUnionId: "union-1",
      },
    } satisfies NonNullable<BuildChannelInboundEventContextParams["channelContext"]>;
    const ctx = buildChannelInboundEventContext(
      createInboundParams({
        channelContext,
      }),
    );

    expect(ctx.ChannelContext?.sender?.testUnionId).toBe("union-1");
  });
});
