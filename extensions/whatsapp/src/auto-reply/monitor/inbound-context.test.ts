// Whatsapp tests cover inbound context plugin behavior.
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
} from "./inbound-context.js";

type ReplyContextParams = Parameters<typeof resolveVisibleWhatsAppReplyContext>[0];

const makeBlockedQuotedReplyMessage = (id: string): ReplyContextParams["msg"] =>
  createTestWebInboundMessage({
    event: { id },
    payload: { body: "Current message" },
    platform: {
      chatJid: "123@g.us",
      recipientJid: "+2000",
      senderName: "Alice",
      senderJid: "111@s.whatsapp.net",
      senderE164: "+111",
      selfE164: "+999",
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "group",
        id: "123@g.us",
      },
      sender: {
        id: "111@s.whatsapp.net",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    quote: {
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: {
        displayName: "Mallory (+999)",
        jid: "999@s.whatsapp.net",
      },
    },
  });

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
      {
        sender: "Alice (+111)",
        body: "Allowed context",
        senderJid: "111@s.whatsapp.net",
      },
    ]);
  });

  it("redacts blocked quoted replies in allowlist mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: makeBlockedQuotedReplyMessage("msg-reply-1"),
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply).toBeNull();
  });

  it("keeps blocked quoted replies in allowlist_quote mode", () => {
    const reply = resolveVisibleWhatsAppReplyContext({
      msg: makeBlockedQuotedReplyMessage("msg-reply-2"),
      mode: "allowlist_quote",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply).toEqual({
      id: "blocked-reply",
      body: "Blocked quoted text",
      sender: {
        jid: "999@s.whatsapp.net",
        lid: null,
        e164: "+999",
        label: "Mallory (+999)",
      },
    });
  });

  it("renders structured quoted media only at the visible preview boundary", () => {
    const msg = makeBlockedQuotedReplyMessage("msg-reply-media");
    msg.quote = {
      context: {
        id: "quoted-sticker",
        body: "",
        media: { contentType: "image/webp", kind: "sticker" },
        sender: { jid: "111@s.whatsapp.net", label: "Alice (+111)" },
      },
    };

    const reply = resolveVisibleWhatsAppReplyContext({
      msg,
      mode: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFrom: ["+111"],
    });

    expect(reply?.body).toBe("<media:sticker>");
    expect(reply?.media).toEqual({ contentType: "image/webp", kind: "sticker" });
  });
});
