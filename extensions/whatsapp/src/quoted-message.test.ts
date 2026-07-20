// Whatsapp tests cover quoted message plugin behavior.
import { generateWAMessageFromContent } from "baileys";
import { describe, expect, it } from "vitest";
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
});
