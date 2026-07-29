/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type PreparedChannelInbound,
  projectPreparedChannelInbound,
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

  it("builds a portable prepared inbound without channel-native types", () => {
    const inbound = {
      channel: "example",
      accountId: "work",
      event: {
        id: "event-1",
        fullId: "example:event-1",
        timestamp: 1_710_000_000,
      },
      from: "example:user:u1",
      sender: {
        id: "u1",
        name: "Alice",
      },
      conversation: {
        kind: "group",
        id: "room-1",
        label: "Example Room",
      },
      route: {
        agentId: "main",
        accountId: "work",
        routeSessionKey: "agent:main:example:group:room-1",
      },
      reply: {
        to: "example:room:room-1",
        replyToId: "quoted-1",
      },
      message: {
        body: "agent body",
        bodyForAgent: "agent body",
        rawBody: "raw body",
        commandBody: "/status",
      },
      command: {
        kind: "text-slash",
        body: "/status",
        authorization: {
          kind: "denied",
          reason: "sender_not_allowed",
        },
      },
      media: [
        {
          path: "/tmp/example.jpg",
          contentType: "image/jpeg",
          kind: "image",
        },
      ],
      context: {
        senderE164: "+15550001111",
      },
    } satisfies PreparedChannelInbound;

    const projected = projectPreparedChannelInbound({
      inbound,
      control: { messageReceivedHooks: "core" },
    });
    expect(projected.input).toEqual({
      id: "event-1",
      timestamp: 1_710_000_000,
      rawText: "raw body",
      textForAgent: "agent body",
      textForCommands: "/status",
      raw: inbound,
    });
    expect(inbound.command.authorization).toEqual({
      kind: "denied",
      reason: "sender_not_allowed",
    });

    const ctx = projected.context;
    expect(ctx).toMatchObject({
      MessageSid: "event-1",
      MessageSidFull: "example:event-1",
      BodyForAgent: "agent body",
      RawBody: "raw body",
      CommandBody: "/status",
      ReplyToId: "quoted-1",
      CommandAuthorized: false,
      ConversationLabel: "Example Room",
      GroupSubject: "Example Room",
      SenderE164: "+15550001111",
      media: [
        {
          path: "/tmp/example.jpg",
          contentType: "image/jpeg",
          kind: "image",
        },
      ],
    });
  });
});
