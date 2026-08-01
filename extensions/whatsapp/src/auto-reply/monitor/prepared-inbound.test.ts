import { describe, expect, it } from "vitest";
import { projectPreparedChannelInbound, type PreparedChannelInbound } from "./prepared-inbound.js";

describe("WhatsApp prepared inbound", () => {
  it("projects portable facts without WhatsApp transport state", () => {
    const inbound = {
      channel: "whatsapp",
      accountId: "work",
      event: {
        id: "event-1",
        fullId: "whatsapp:event-1",
        timestamp: 1_710_000_000,
      },
      from: "whatsapp:user:u1",
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
        routeSessionKey: "agent:main:whatsapp:group:room-1",
      },
      reply: {
        to: "whatsapp:room:room-1",
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
    expect(projected.context).toMatchObject({
      MessageSid: "event-1",
      MessageSidFull: "whatsapp:event-1",
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
