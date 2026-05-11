import type { WAMessage } from "baileys";
import { describe, expect, it } from "vitest";
import { combineWhatsAppSendResults, normalizeWhatsAppSendResult } from "./send-result.js";

describe("WhatsApp send receipts", () => {
  it("attaches receipts to accepted provider sends", () => {
    const result = normalizeWhatsAppSendResult(
      {
        key: {
          id: "wa-1",
          remoteJid: "123@s.whatsapp.net",
          fromMe: true,
        },
      } as unknown as WAMessage,
      "text",
    );

    expect(result.receipt?.sentAt).toBeTypeOf("number");
    expect(result.receipt).toEqual({
      primaryPlatformMessageId: "wa-1",
      platformMessageIds: ["wa-1"],
      sentAt: result.receipt?.sentAt,
      raw: [
        {
          channel: "whatsapp",
          messageId: "wa-1",
          toJid: "123@s.whatsapp.net",
          meta: {
            fromMe: true,
            participant: undefined,
          },
        },
      ],
      parts: [
        {
          index: 0,
          platformMessageId: "wa-1",
          kind: "text",
          raw: {
            channel: "whatsapp",
            messageId: "wa-1",
            toJid: "123@s.whatsapp.net",
            meta: {
              fromMe: true,
              participant: undefined,
            },
          },
        },
      ],
    });
  });

  it("combines receipts in provider send order", () => {
    const media = normalizeWhatsAppSendResult(
      { key: { id: "media-1", remoteJid: "chat@s.whatsapp.net" } } as unknown as WAMessage,
      "media",
    );
    const text = normalizeWhatsAppSendResult(
      { key: { id: "text-1", remoteJid: "chat@s.whatsapp.net" } } as unknown as WAMessage,
      "text",
    );

    const combined = combineWhatsAppSendResults("media", [media, text]);

    expect(combined.receipt?.sentAt).toBeTypeOf("number");
    expect(combined.receipt).toEqual({
      primaryPlatformMessageId: "media-1",
      platformMessageIds: ["media-1", "text-1"],
      sentAt: combined.receipt?.sentAt,
      raw: [
        {
          channel: "whatsapp",
          messageId: "media-1",
          toJid: "chat@s.whatsapp.net",
          meta: {
            fromMe: undefined,
            participant: undefined,
          },
        },
        {
          channel: "whatsapp",
          messageId: "text-1",
          toJid: "chat@s.whatsapp.net",
          meta: {
            fromMe: undefined,
            participant: undefined,
          },
        },
      ],
      parts: [
        {
          index: 0,
          platformMessageId: "media-1",
          kind: "media",
          raw: {
            channel: "whatsapp",
            messageId: "media-1",
            toJid: "chat@s.whatsapp.net",
            meta: {
              fromMe: undefined,
              participant: undefined,
            },
          },
        },
        {
          index: 1,
          platformMessageId: "text-1",
          kind: "media",
          raw: {
            channel: "whatsapp",
            messageId: "text-1",
            toJid: "chat@s.whatsapp.net",
            meta: {
              fromMe: undefined,
              participant: undefined,
            },
          },
        },
      ],
    });
  });
});
