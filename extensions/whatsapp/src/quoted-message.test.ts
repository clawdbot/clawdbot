// Whatsapp tests cover quoted message plugin behavior.
import { generateWAMessageFromContent } from "baileys";
import { describe, expect, it, vi } from "vitest";
import {
  buildQuotedMessageOptions,
  cacheInboundMessageMeta,
  lookupInboundMessageMeta,
  lookupInboundMessageMetaForTarget,
} from "./quoted-message.js";

describe("quoted message metadata cache", () => {
  it("scopes cached metadata by account id", () => {
    cacheInboundMessageMeta("account-a", "1555@s.whatsapp.net", "msg-1", {
      participant: "111@s.whatsapp.net",
      body: "hello from a",
      fromMe: true,
    });
    cacheInboundMessageMeta("account-b", "1555@s.whatsapp.net", "msg-1", {
      participant: "222@s.whatsapp.net",
      body: "hello from b",
      fromMe: false,
    });

    expect(lookupInboundMessageMeta("account-a", "1555@s.whatsapp.net", "msg-1")).toEqual({
      participant: "111@s.whatsapp.net",
      body: "hello from a",
      fromMe: true,
    });
    expect(lookupInboundMessageMeta("account-b", "1555@s.whatsapp.net", "msg-1")).toEqual({
      participant: "222@s.whatsapp.net",
      body: "hello from b",
      fromMe: false,
    });
  });

  it("can recover the original remoteJid for a matching direct-chat target", () => {
    cacheInboundMessageMeta("account-c", "277038292303944@lid", "msg-2", {
      participant: "5511976136970@s.whatsapp.net",
      body: "hello from lid chat",
      fromMe: true,
    });

    expect(
      lookupInboundMessageMetaForTarget("account-c", "5511976136970@s.whatsapp.net", "msg-2"),
    ).toEqual({
      remoteJid: "277038292303944@lid",
      participant: "5511976136970@s.whatsapp.net",
      body: "hello from lid chat",
      fromMe: true,
    });
    expect(
      lookupInboundMessageMetaForTarget("account-c", "99999999999@s.whatsapp.net", "msg-2"),
    ).toBeUndefined();
    expect(
      lookupInboundMessageMetaForTarget("missing", "5511976136970@s.whatsapp.net", "msg-2"),
    ).toBeUndefined();
  });

  it("can recover a direct-chat remoteJid when only sender E164 was cached", () => {
    cacheInboundMessageMeta("account-e", "277038292303944@lid", "msg-4", {
      participantE164: "+5511976136970",
      body: "hello from e164 participant",
    });

    expect(
      lookupInboundMessageMetaForTarget("account-e", "5511976136970@s.whatsapp.net", "msg-4"),
    ).toEqual({
      remoteJid: "277038292303944@lid",
      participant: undefined,
      participantE164: "+5511976136970",
      body: "hello from e164 participant",
      fromMe: undefined,
    });
  });

  it("lets Baileys encode the self participant for a cached outbound quote (#91445)", () => {
    const remoteJid = "120363400000000000@g.us";
    const userJid = "15551112222@s.whatsapp.net";
    cacheInboundMessageMeta("account-self", remoteJid, "bot-msg-1", {
      fromMe: true,
      body: "bot reply text",
    });
    const cached = lookupInboundMessageMeta("account-self", remoteJid, "bot-msg-1");
    const quoteOptions = buildQuotedMessageOptions({
      messageId: "bot-msg-1",
      remoteJid,
      fromMe: cached?.fromMe,
      participant: cached?.participant,
      messageText: cached?.body,
    });
    if (!quoteOptions) {
      throw new Error("expected quote options");
    }

    const encoded = generateWAMessageFromContent(
      remoteJid,
      { extendedTextMessage: { text: "user reply" } },
      { ...quoteOptions, userJid },
    );

    expect(quoteOptions.quoted?.key.participant).toBeUndefined();
    expect(encoded.message?.extendedTextMessage?.contextInfo).toMatchObject({
      participant: userJid,
      stanzaId: "bot-msg-1",
      quotedMessage: { conversation: "bot reply text" },
    });
  });

  it.each([
    {
      name: "lookup-proven LID self-chat quote",
      destinationJid: "15551112222@s.whatsapp.net",
      requestedJid: "15551112222@s.whatsapp.net",
      remoteJid: "277038292303944@lid",
      lookupTargetJid: "15551112222@s.whatsapp.net",
    },
    {
      name: "PN quote routed through its mapped LID",
      destinationJid: "277038292303944@lid",
      requestedJid: "15551112222@s.whatsapp.net",
      remoteJid: "15551112222@s.whatsapp.net",
      lookupTargetJid: undefined,
    },
  ])("keeps $name in the destination conversation", (input) => {
    const quoteOptions = buildQuotedMessageOptions({
      messageId: "alias-quote",
      remoteJid: input.remoteJid,
      fromMe: true,
      destinationJid: input.destinationJid,
      requestedJid: input.requestedJid,
      lookupTargetJid: input.lookupTargetJid,
      messageText: "quoted body",
    });
    if (!quoteOptions) {
      throw new Error("expected quote options");
    }

    const encoded = generateWAMessageFromContent(
      input.destinationJid,
      { extendedTextMessage: { text: "reply" } },
      { ...quoteOptions, userJid: input.requestedJid },
    );

    expect(quoteOptions.quoted?.key.remoteJid).toBe(input.destinationJid);
    expect(encoded.message?.extendedTextMessage?.contextInfo?.remoteJid).toBeUndefined();
  });

  it("preserves unrelated direct and cross-conversation quote JIDs", () => {
    const quoteOptions = buildQuotedMessageOptions({
      messageId: "cross-chat-quote",
      remoteJid: "277038292303944@lid",
      fromMe: false,
      destinationJid: "15551112222@s.whatsapp.net",
      requestedJid: "15551112222@s.whatsapp.net",
      participant: "19998887777@s.whatsapp.net",
      messageText: "other chat",
    });
    if (!quoteOptions) {
      throw new Error("expected quote options");
    }

    const encoded = generateWAMessageFromContent(
      "15551112222@s.whatsapp.net",
      { extendedTextMessage: { text: "reply" } },
      { ...quoteOptions, userJid: "15551112222@s.whatsapp.net" },
    );

    expect(quoteOptions.quoted?.key.remoteJid).toBe("277038292303944@lid");
    expect(encoded.message?.extendedTextMessage?.contextInfo?.remoteJid).toBe(
      "277038292303944@lid",
    );
  });

  it("renders a cached structured media fact into the quote preview", () => {
    const remoteJid = "15551112222@s.whatsapp.net";
    cacheInboundMessageMeta("account-media", remoteJid, "media-msg-1", {
      body: "",
      media: { contentType: "image/webp", kind: "sticker" },
    });
    const cached = lookupInboundMessageMeta("account-media", remoteJid, "media-msg-1");
    const quoteOptions = buildQuotedMessageOptions({
      messageId: "media-msg-1",
      remoteJid,
      messageText: cached?.body,
      media: cached?.media,
    });

    expect(quoteOptions?.quoted?.message).toEqual({ conversation: "<media:sticker>" });
  });

  it("does not recover metadata from another chat when the target conversation differs", () => {
    cacheInboundMessageMeta("account-d", "120363400000000000@g.us", "msg-3", {
      participant: "111@s.whatsapp.net",
      body: "group secret",
    });

    expect(
      lookupInboundMessageMetaForTarget("account-d", "222@s.whatsapp.net", "msg-3"),
    ).toBeUndefined();
  });

  it.each(["account-a-first", "account-b-first"] as const)(
    "keeps same-id cache entries isolated with $s insertion order",
    (order) => {
      const messageId = `shared-${order}`;
      const entries = [
        {
          accountId: "isolation-a",
          remoteJid: "11111@s.whatsapp.net",
          participant: "11111@s.whatsapp.net",
          body: "account a body",
        },
        {
          accountId: "isolation-b",
          remoteJid: "22222@s.whatsapp.net",
          participant: "22222@s.whatsapp.net",
          body: "account b body",
        },
      ];
      if (order === "account-b-first") {
        entries.reverse();
      }
      for (const entry of entries) {
        cacheInboundMessageMeta(entry.accountId, entry.remoteJid, messageId, {
          participant: entry.participant,
          body: entry.body,
        });
      }

      expect(
        lookupInboundMessageMetaForTarget("isolation-a", "11111@s.whatsapp.net", messageId)?.body,
      ).toBe("account a body");
      expect(
        lookupInboundMessageMetaForTarget("isolation-b", "22222@s.whatsapp.net", messageId)?.body,
      ).toBe("account b body");
      expect(
        lookupInboundMessageMetaForTarget("isolation-a", "22222@s.whatsapp.net", messageId),
      ).toBeUndefined();
      expect(
        lookupInboundMessageMetaForTarget("isolation-b", "11111@s.whatsapp.net", messageId),
      ).toBeUndefined();
    },
  );

  it.each([
    ["auto-reply", lookupInboundMessageMeta],
    ["outbound", lookupInboundMessageMetaForTarget],
  ] as const)("sends an expired %s quote as an ordinary message", (name, lookup) => {
    const accountId = `quote-expiry-${name}`;
    const remoteJid = "120363000000000000@g.us";
    const messageId = "expired-inbound";
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const encodeReply = () => {
      const cached = lookup(accountId, remoteJid, messageId);
      return generateWAMessageFromContent(
        remoteJid,
        { extendedTextMessage: { text: "Reply remains visible" } },
        {
          userJid: "15555550123@s.whatsapp.net",
          messageId: "outbound-reply",
          timestamp: new Date(now),
          ...buildQuotedMessageOptions({
            messageId,
            remoteJid,
            participant: cached?.participant,
            messageText: cached?.body,
            media: cached?.media,
          }),
        },
      ).message?.extendedTextMessage;
    };
    try {
      cacheInboundMessageMeta(accountId, remoteJid, messageId, {
        body: "Original message",
        participant: "15555550124@s.whatsapp.net",
      });
      expect(encodeReply()?.contextInfo).toMatchObject({
        stanzaId: messageId,
        quotedMessage: { conversation: "Original message" },
      });

      clock.mockReturnValue(now + 10 * 60 * 1000 + 1);
      expect(lookup(accountId, remoteJid, messageId)).toBeUndefined();
      const expiredReply = encodeReply();
      expect(expiredReply?.text).toBe("Reply remains visible");
      expect(expiredReply?.contextInfo).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });
});
