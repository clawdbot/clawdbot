// WhatsApp tests cover inbound message alias compatibility.
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  normalizeWebInboundMessage,
  withDeprecatedWebInboundMessageFlatAliases,
} from "./message-aliases.js";
import type { monitorWebInbox } from "./monitor.js";
import { createAcceptedWhatsAppSendResult } from "./send-result.test-helper.js";
import { createTestWhatsAppInboundAdmission } from "./test-message.test-helper.js";
import type { LegacyFlatWebInboundMessage, WebInboundCallbackMessage } from "./types.js";

type MonitorWebInboxMessage = Parameters<Parameters<typeof monitorWebInbox>[0]["onMessage"]>[0];

function createCanonicalMessage(overrides: Partial<WebInboundCallbackMessage> = {}) {
  return withDeprecatedWebInboundMessageFlatAliases({
    event: {
      id: "event-1",
      timestamp: 1_700_000_000,
      isBatched: false,
    },
    payload: {
      body: "hello",
      media: {
        path: "/tmp/image.jpg",
        type: "image/jpeg",
        fileName: "image.jpg",
        url: "https://example.com/image.jpg",
      },
      untrustedStructuredContext: [
        {
          label: "WhatsApp contact",
          source: "whatsapp",
          type: "contact",
          payload: { name: "Alice" },
        },
      ],
    },
    platform: {
      chatJid: "123@g.us",
      recipientJid: "+15550000001",
      senderJid: "15550000002@s.whatsapp.net",
      senderE164: "+15550000002",
      senderName: "Alice",
      pushName: "Alice P",
      selfE164: "+15550000001",
      fromMe: false,
      sendComposing: vi.fn(async () => undefined),
      reply: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-1")),
      sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-1")),
    },
    from: "123@g.us",
    conversationId: "123@g.us",
    accountId: "default",
    chatType: "group",
    quote: {
      id: "quote-1",
      body: "quoted",
      sender: {
        displayName: "Bob",
        jid: "15550000003@s.whatsapp.net",
        e164: "+15550000003",
      },
    },
    group: {
      subject: "Test Group",
      participants: ["15550000002@s.whatsapp.net"],
      mentions: {
        jids: ["15550000001@s.whatsapp.net"],
      },
    },
    ...overrides,
  });
}

const callbackMessageWithoutAdmissionFacts = {
  event: {
    id: "event-missing-admission",
  },
  payload: {
    body: "missing admission",
  },
  platform: {
    chatJid: "123@g.us",
    recipientJid: "+15550000001",
    sendComposing: async () => undefined,
    reply: async () => createAcceptedWhatsAppSendResult("text", "reply-missing-admission"),
    sendMedia: async () => createAcceptedWhatsAppSendResult("media", "media-missing-admission"),
  },
};

describe("WhatsApp inbound flat aliases", () => {
  it("rejects callback messages without admission facts", () => {
    expectTypeOf(
      callbackMessageWithoutAdmissionFacts,
    ).not.toMatchTypeOf<WebInboundCallbackMessage>();
  });

  it("keeps deprecated admission fields typed on monitor callbacks", () => {
    expectTypeOf<MonitorWebInboxMessage>().toMatchTypeOf<{
      admission: NonNullable<WebInboundCallbackMessage["admission"]>;
      from: string;
      conversationId: string;
      accountId: string;
      accessControlPassed?: boolean;
      chatType: "direct" | "group";
    }>();
  });

  it("keeps deprecated flat aliases live against canonical contexts", async () => {
    const msg = createCanonicalMessage();
    const nextReply = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-2"));

    expect(msg.body).toBe("hello");
    msg.payload.body = "nested body";
    expect(msg.body).toBe("nested body");
    msg.body = "flat body";
    expect(msg.payload.body).toBe("flat body");

    msg.platform.chatJid = "456@g.us";
    expect(msg.chatId).toBe("456@g.us");
    msg.chatId = "789@g.us";
    expect(msg.platform.chatJid).toBe("789@g.us");

    msg.payload.media = { path: "/tmp/next.jpg", type: "image/png" };
    expect(msg.mediaPath).toBe("/tmp/next.jpg");
    expect(msg.mediaType).toBe("image/png");
    msg.mediaFileName = "next.jpg";
    msg.mediaUrl = "https://example.com/next.jpg";
    expect(msg.payload.media).toMatchObject({
      fileName: "next.jpg",
      url: "https://example.com/next.jpg",
    });

    msg.group.mentions!.jids = ["first@s.whatsapp.net"];
    expect(msg.mentions).toEqual(["first@s.whatsapp.net"]);
    msg.mentionedJids = ["second@s.whatsapp.net"];
    expect(msg.group?.mentions?.jids).toEqual(["second@s.whatsapp.net"]);
    expect(msg.mentions).toEqual(["second@s.whatsapp.net"]);

    msg.reply = nextReply;
    expect(msg.platform.reply).toBe(nextReply);
    await msg.platform.reply("ok");
    expect(nextReply).toHaveBeenCalledWith("ok");

    expect(Object.keys(msg)).toContain("body");
    expect(Object.keys(msg)).toContain("chatId");
  });

  it("keeps deprecated admission top-level fields aligned with admission", () => {
    const msg = createCanonicalMessage({
      admission: createTestWhatsAppInboundAdmission({
        conversation: {
          kind: "group",
          id: "123@g.us",
        },
        sender: {
          id: "+15550000002",
        },
        senderAccess: {
          reasonCode: "group_policy_allowed",
        },
      }),
    });

    expect(msg.from).toBe("123@g.us");
    msg.admission!.conversation.id = "456@g.us";
    expect(msg.from).toBe("456@g.us");
    expect(msg.conversationId).toBe("456@g.us");

    msg.conversationId = "789@g.us";
    expect(msg.admission?.conversation.id).toBe("789@g.us");
    expect(msg.admission?.conversation.groupSessionId).toBe("789@g.us");
    expect(msg.from).toBe("789@g.us");

    msg.admission!.accountId = "work";
    expect(msg.accountId).toBe("work");
    msg.accountId = "ops";
    expect(msg.admission?.accountId).toBe("ops");
    expect(msg.admission?.account.accountId).toBe("ops");

    msg.admission!.conversation.kind = "direct";
    expect(msg.chatType).toBe("direct");
    msg.chatType = "group";
    expect(msg.admission?.conversation.kind).toBe("group");

    expect(msg.accessControlPassed).toBe(true);
    msg.admission!.ingress.decision = "block";
    expect(msg.accessControlPassed).toBe(false);
    msg.accessControlPassed = true;
    expect(msg.admission?.ingress.decision).toBe("block");
    expect(msg.accessControlPassed).toBe(false);
  });

  it("keeps deprecated admission top-level fields usable without admission", () => {
    const msg = createCanonicalMessage();

    expect(msg.from).toBe("123@g.us");
    msg.from = "+15550000002";
    expect(msg.from).toBe("+15550000002");
    expect(msg.conversationId).toBe("+15550000002");

    expect(msg.accessControlPassed).toBeUndefined();
    msg.accessControlPassed = true;
    expect(msg.accessControlPassed).toBe(true);
  });

  it("normalizes canonical messages without admission without rebuilding admission facts", () => {
    const normalized = normalizeWebInboundMessage({
      event: {
        id: "group-no-admission",
        timestamp: 1_700_000_456,
      },
      payload: {
        body: "hello group",
      },
      platform: {
        chatJid: "123@g.us",
        recipientJid: "+15550000001",
        senderJid: "15550000002@s.whatsapp.net",
        senderE164: "+15550000002",
        senderName: "Alice",
        sendComposing: vi.fn(async () => undefined),
        reply: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-group")),
        sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-group")),
      },
      from: "123@g.us",
      conversationId: "123@g.us",
      accountId: "work",
      accessControlPassed: true,
      chatType: "group",
    });

    expect(normalized.admission).toBeUndefined();
    expect(normalized.from).toBe("123@g.us");
    expect(normalized.conversationId).toBe("123@g.us");
    expect(normalized.accountId).toBe("work");
    expect(normalized.chatType).toBe("group");

    normalized.conversationId = "456@g.us";
    expect(normalized.admission).toBeUndefined();
    expect(normalized.from).toBe("456@g.us");
    expect(normalized.conversationId).toBe("456@g.us");
  });

  it("normalizes legacy flat messages into canonical contexts with live aliases", () => {
    const legacyReply = vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-legacy"));
    const legacy: LegacyFlatWebInboundMessage = {
      id: "legacy-1",
      timestamp: 1_700_000_123,
      from: "+15550000002",
      conversationId: "+15550000002",
      accountId: "default",
      chatType: "direct",
      to: "+15550000001",
      body: "legacy body",
      chatId: "15550000002@s.whatsapp.net",
      replyToId: "quote-legacy",
      replyToBody: "legacy quoted",
      replyToSender: "Legacy Sender",
      replyToSenderJid: "15550000003@s.whatsapp.net",
      groupSubject: "Legacy Group",
      mentionedJids: ["15550000001@s.whatsapp.net"],
      sendComposing: vi.fn(async () => undefined),
      reply: legacyReply,
      sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-legacy")),
      mediaPath: "/tmp/legacy.jpg",
      mediaType: "image/jpeg",
      isBatched: true,
    };

    const normalized = normalizeWebInboundMessage(legacy);

    expect(normalized.event).toMatchObject({
      id: "legacy-1",
      timestamp: 1_700_000_123,
      isBatched: true,
    });
    expect(normalized.payload.body).toBe("legacy body");
    expect(normalized.payload.media).toMatchObject({
      path: "/tmp/legacy.jpg",
      type: "image/jpeg",
    });
    expect(normalized.platform).toMatchObject({
      chatJid: "15550000002@s.whatsapp.net",
      recipientJid: "+15550000001",
    });
    expect(normalized.admission?.ingress).toMatchObject({
      admission: "dispatch",
      decision: "allow",
      decisiveGateId: "legacy-flat-compat",
      reasonCode: "dm_policy_allowlisted",
    });
    expect(normalized.accessControlPassed).toBe(true);
    expect(normalized.quote).toMatchObject({
      id: "quote-legacy",
      body: "legacy quoted",
      sender: {
        displayName: "Legacy Sender",
        jid: "15550000003@s.whatsapp.net",
      },
    });
    expect(normalized.group).toMatchObject({
      subject: "Legacy Group",
      mentions: {
        jids: ["15550000001@s.whatsapp.net"],
      },
    });

    normalized.payload.body = "canonical update";
    expect(normalized.body).toBe("canonical update");
    normalized.replyToSender = "Updated Sender";
    expect(normalized.quote?.sender?.displayName).toBe("Updated Sender");
  });

  it("normalizes blocked legacy flat admission fields through the compatibility seam", () => {
    const normalized = normalizeWebInboundMessage({
      id: "legacy-blocked",
      from: "+15550000002",
      conversationId: "+15550000002",
      accountId: "default",
      accessControlPassed: false,
      chatType: "direct",
      to: "+15550000001",
      body: "blocked legacy body",
      chatId: "15550000002@s.whatsapp.net",
      sendComposing: vi.fn(async () => undefined),
      reply: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-blocked")),
      sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-blocked")),
    });

    expect(normalized.admission).toMatchObject({
      ingress: {
        admission: "drop",
        decision: "block",
        decisiveGateId: "legacy-flat-compat",
        reasonCode: "no_policy_match",
      },
      senderAccess: {
        allowed: false,
        decision: "block",
        reasonCode: "no_policy_match",
      },
    });
    expect(normalized.accessControlPassed).toBe(false);
  });
});
