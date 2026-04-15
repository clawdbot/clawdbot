import { describe, expect, it } from "vitest";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";

describe("whatsapp inbound context visibility", () => {
  it("filters non-allowlisted group history from supplemental context", () => {
    const history = resolveVisibleWhatsAppGroupHistory({
      history: [
        {
          sender: "Alice (+111)",
          body: "Allowed context",
          senderJid: "111@s.whatsapp.net",
        },
        {
          sender: "Mallory (+999)",
          body: "Blocked context",
          senderJid: "999@s.whatsapp.net",
        },
      ],
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(history).toEqual([
      expect.objectContaining({
        sender: "Alice (+111)",
        body: "Allowed context",
      }),
    ]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: {
        id: "msg-reply-1",
        from: "123@g.us",
        conversationId: "123@g.us",
        to: "+2000",
        chatType: "group",
        body: "Current message",
        senderName: "Alice",
        senderJid: "111@s.whatsapp.net",
        senderE164: "+111",
        selfE164: "+999",
        replyToId: "blocked-reply",
        replyToBody: "Blocked quoted text",
        replyToSender: "Mallory (+999)",
        replyToSenderJid: "999@s.whatsapp.net",
      },
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    } as Parameters<typeof resolveVisibleWhatsAppReplyContext>[0]);

    expect(reply).toBeNull();
  });

  it("keeps blocked quoted replies in allowlist_quote mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: {
        id: "msg-reply-2",
        from: "123@g.us",
        conversationId: "123@g.us",
        to: "+2000",
        chatType: "group",
        body: "Current message",
        senderName: "Alice",
        senderJid: "111@s.whatsapp.net",
        senderE164: "+111",
        selfE164: "+999",
        replyToId: "blocked-reply",
        replyToBody: "Blocked quoted text",
        replyToSender: "Mallory (+999)",
        replyToSenderJid: "999@s.whatsapp.net",
      },
      mode: "allowlist_quote",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    } as Parameters<typeof resolveVisibleWhatsAppReplyContext>[0]);

    expect(reply).toMatchObject({
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: expect.objectContaining({
        label: "Mallory (+999)",
      }),
    });
  });
});
