// Whatsapp tests cover send result plugin behavior.
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  combineWhatsAppSendResults,
  mergeWhatsAppAcceptedSendError,
  normalizeWhatsAppSendResult,
  requireWhatsAppAcceptedSendResult,
} from "./send-result.js";

describe("WhatsApp send receipts", () => {
  it.each([
    { name: "no provider result", result: undefined },
    { name: "no message key", result: { key: {} } as unknown as WAMessage },
    { name: "a blank message key", result: { key: { id: "  " } } as unknown as WAMessage },
  ])("rejects $name before fabricating a receipt", ({ result }) => {
    expect(() => normalizeWhatsAppSendResult(result, "text")).toThrow(
      PlatformMessageNotDispatchedError,
    );
  });

  it("rejects listener results that claim an unauthenticated provider receipt", () => {
    expect(() =>
      requireWhatsAppAcceptedSendResult({
        kind: "text",
        messageId: "unknown",
        keys: [],
        providerAccepted: false,
      }),
    ).toThrow(PlatformMessageNotDispatchedError);
  });

  it("rejects empty send batches instead of fabricating an unknown receipt", () => {
    expect(() => combineWhatsAppSendResults("text", [])).toThrow(PlatformMessageNotDispatchedError);
  });

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

  it("enriches matching partial-delivery ids that do not yet carry their canonical receipt", () => {
    const accepted = normalizeWhatsAppSendResult(
      { key: { id: "receipt-enrichment", remoteJid: "123@s.whatsapp.net" } } as WAMessage,
      "text",
    );
    const bookkeepingError = new Error("accepted result metadata was not attached");
    const partial = createChannelPartialDeliveryError(bookkeepingError, {
      messageIds: [accepted.messageId],
      visibleReplySent: true,
    });

    const enriched = mergeWhatsAppAcceptedSendError({
      error: partial,
      kind: "text",
      results: [accepted],
    });

    expect(isChannelPartialDeliveryError(enriched)).toBe(true);
    if (!isChannelPartialDeliveryError(enriched)) {
      throw new Error("matching partial-delivery ids suppressed missing receipt enrichment");
    }
    expect(enriched).not.toBe(partial);
    expect(enriched.deliveryResult.receipt?.platformMessageIds).toEqual(["receipt-enrichment"]);
    expect(enriched.deliveryResult.receipt?.parts[0]?.raw).toMatchObject({
      channel: "whatsapp",
      messageId: "receipt-enrichment",
      toJid: "123@s.whatsapp.net",
    });
    expect(enriched).toHaveProperty("cause", bookkeepingError);
    expect(enriched).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });

  it("rebuilds matching nested receipts whose existing raw provider metadata is incomplete", () => {
    const accepted = normalizeWhatsAppSendResult(
      {
        key: {
          id: "receipt-raw-enrichment",
          remoteJid: "123@s.whatsapp.net",
          fromMe: true,
          participant: "456@s.whatsapp.net",
        },
      } as WAMessage,
      "text",
    );
    const providerReceipt = accepted.receipt;
    if (!providerReceipt) {
      throw new Error("accepted WhatsApp send did not expose its provider receipt");
    }
    accepted.receipt = {
      ...providerReceipt,
      threadId: "provider-thread",
      replyToId: "provider-reply",
      editToken: "provider-edit-token",
      deleteToken: "provider-delete-token",
      parts: providerReceipt.parts.map((part) =>
        Object.assign({}, part, {
          index: 7,
          threadId: "provider-thread",
          replyToId: "provider-reply",
        }),
      ),
    };
    const incompleteReceipt = {
      ...accepted.receipt,
      raw: [{ channel: "whatsapp", messageId: accepted.messageId }],
      parts: accepted.receipt.parts.map((part) =>
        Object.assign({}, part, {
          raw: { channel: "whatsapp", messageId: part.platformMessageId },
        }),
      ),
    };
    const originalCause = new Error("provider bookkeeping failed after accepted delivery");
    const partial = createChannelPartialDeliveryError(originalCause, {
      messageIds: [accepted.messageId],
      receipt: incompleteReceipt,
      visibleReplySent: true,
    });
    const wrapped = createChannelPartialDeliveryError(partial, {
      messageIds: [accepted.messageId],
      receipt: incompleteReceipt,
      visibleReplySent: true,
    });

    const enriched = mergeWhatsAppAcceptedSendError({
      error: wrapped,
      kind: "text",
      results: [accepted],
    });

    expect(isChannelPartialDeliveryError(enriched)).toBe(true);
    if (!isChannelPartialDeliveryError(enriched)) {
      throw new Error("existing incomplete nested raw suppressed canonical receipt reconstruction");
    }
    expect(enriched).not.toBe(wrapped);
    expect(enriched).toHaveProperty("cause", originalCause);
    expect(enriched.deliveryResult.receipt).toMatchObject({
      primaryPlatformMessageId: "receipt-raw-enrichment",
      platformMessageIds: ["receipt-raw-enrichment"],
      threadId: "provider-thread",
      replyToId: "provider-reply",
      editToken: "provider-edit-token",
      deleteToken: "provider-delete-token",
      raw: [
        {
          channel: "whatsapp",
          messageId: "receipt-raw-enrichment",
          toJid: "123@s.whatsapp.net",
          meta: {
            fromMe: true,
            participant: "456@s.whatsapp.net",
          },
        },
      ],
      parts: [
        {
          platformMessageId: "receipt-raw-enrichment",
          kind: "text",
          index: 7,
          threadId: "provider-thread",
          replyToId: "provider-reply",
          raw: {
            channel: "whatsapp",
            messageId: "receipt-raw-enrichment",
            toJid: "123@s.whatsapp.net",
            meta: {
              fromMe: true,
              participant: "456@s.whatsapp.net",
            },
          },
        },
      ],
    });
    expect(enriched).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
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
