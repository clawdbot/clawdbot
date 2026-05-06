import type { WAMessage } from "@whiskeysockets/baileys";
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

    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "wa-1",
      platformMessageIds: ["wa-1"],
      parts: [
        expect.objectContaining({
          platformMessageId: "wa-1",
          kind: "text",
          raw: expect.objectContaining({
            channel: "whatsapp",
            messageId: "wa-1",
            toJid: "123@s.whatsapp.net",
          }),
        }),
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

    expect(combined.receipt).toMatchObject({
      primaryPlatformMessageId: "media-1",
      platformMessageIds: ["media-1", "text-1"],
      parts: [
        expect.objectContaining({ platformMessageId: "media-1", kind: "media" }),
        expect.objectContaining({ platformMessageId: "text-1", kind: "media" }),
      ],
    });
  });
});
