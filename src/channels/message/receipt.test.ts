// Message receipt tests cover receipt state and acknowledgement metadata for channel messages.
import { describe, expect, it } from "vitest";
import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptPrimaryId,
} from "./receipt.js";

describe("createMessageReceiptFromOutboundResults", () => {
  it("builds a multi-part receipt from outbound delivery results", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "telegram", messageId: "m1" },
        { channel: "telegram", messageId: "m2" },
      ],
      kind: "text",
      threadId: "topic-1",
      replyToId: "reply-1",
      sentAt: 123,
    });

    expect(receipt.primaryPlatformMessageId).toBe("m1");
    expect(receipt.platformMessageIds).toEqual(["m1", "m2"]);
    expect(receipt.threadId).toBe("topic-1");
    expect(receipt.replyToId).toBe("reply-1");
    expect(receipt.sentAt).toBe(123);
    expect(
      receipt.parts.map(({ platformMessageId, kind, index }) => ({
        platformMessageId,
        kind,
        index,
      })),
    ).toEqual([
      { platformMessageId: "m1", kind: "text", index: 0 },
      { platformMessageId: "m2", kind: "text", index: 1 },
    ]);
  });

  it.each(
    (["chatId", "channelId", "roomId", "conversationId", "toJid"] as const).flatMap((field) => [
      { field, messageId: undefined, messageIdLabel: "absent" },
      { field, messageId: "", messageIdLabel: "blank" },
    ]),
  )(
    "keeps $field routing metadata with $messageIdLabel messageId out of platform identity",
    ({ field, messageId }) => {
      const result = {
        channel: "demo",
        ...(messageId === undefined ? {} : { messageId }),
        [field]: "route-only",
      };
      const receipt = createMessageReceiptFromOutboundResults({ results: [result], sentAt: 123 });

      expect(receipt.primaryPlatformMessageId).toBeUndefined();
      expect(receipt.platformMessageIds).toEqual([]);
      expect(receipt.parts).toEqual([]);
      expect(receipt.raw).toEqual([result]);
    },
  );

  it("does not use target routing metadata as platform message identity", () => {
    const target = { kind: "channel" as const, id: "route-only" };
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "demo", messageId: "", target }],
      sentAt: 123,
    });

    expect(receipt.primaryPlatformMessageId).toBeUndefined();
    expect(receipt.platformMessageIds).toEqual([]);
    expect(receipt.parts).toEqual([]);
    expect(receipt.raw).toEqual([{ channel: "demo", messageId: "", target }]);
  });

  it.each([
    {
      label: "Synology Chat destination IDs",
      result: { channel: "synology-chat", messageId: "", chatId: "42" },
      receiptMetadata: { threadId: "42" },
    },
    {
      label: "iMessage bridge placeholders",
      result: { channel: "imessage", messageId: "ok" },
      receiptMetadata: { replyToId: "source-1" },
    },
    {
      label: "Slack suppression sentinels",
      result: { channel: "slack", messageId: "suppressed", channelId: "" },
      receiptMetadata: {},
    },
    {
      label: "Twitch skip sentinels",
      result: { channel: "twitch", messageId: "skipped" },
      receiptMetadata: {},
    },
  ])("does not fabricate platform ids from $label", ({ result, receiptMetadata }) => {
    const adapterReceipt = {
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
      ...receiptMetadata,
    };
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ ...result, receipt: adapterReceipt }],
    });

    expect(receipt).toMatchObject({
      ...receiptMetadata,
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
    });
    expect(receipt.primaryPlatformMessageId).toBeUndefined();
  });

  it("preserves nested platform receipts before falling back to delivery ids", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "telegram",
          messageId: "top-level-ignored",
          receipt: {
            primaryPlatformMessageId: "platform-1",
            platformMessageIds: ["platform-1", "platform-2"],
            parts: [
              { platformMessageId: "platform-1", kind: "text", index: 0 },
              { platformMessageId: "platform-2", kind: "media", index: 1 },
            ],
            threadId: "native-thread",
            sentAt: 123,
          },
        },
        { channel: "telegram", messageId: "fallback-1" },
      ],
      kind: "text",
      sentAt: 456,
    });

    expect(receipt.primaryPlatformMessageId).toBe("platform-1");
    expect(receipt.platformMessageIds).toEqual(["platform-1", "platform-2", "fallback-1"]);
    expect(
      receipt.parts.map(({ platformMessageId, kind, index }) => ({
        platformMessageId,
        kind,
        index,
      })),
    ).toEqual([
      { platformMessageId: "platform-1", kind: "text", index: 0 },
      { platformMessageId: "platform-2", kind: "media", index: 1 },
      { platformMessageId: "fallback-1", kind: "text", index: 1 },
    ]);
    expect(receipt.threadId).toBe("native-thread");
    expect(receipt.sentAt).toBe(456);
  });

  it("uses nested canonical threads before the requested route when filling parts", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "googlechat",
          receipt: {
            platformMessageIds: ["m1", "m2"],
            parts: [
              { platformMessageId: "m1", kind: "text", index: 0 },
              { platformMessageId: "m2", kind: "text", index: 1 },
            ],
            threadId: "canonical-thread",
            sentAt: 123,
          },
        },
      ],
      threadId: "requested-thread",
    });

    expect(receipt.threadId).toBe("canonical-thread");
    expect(receipt.parts.map((part) => part.threadId)).toEqual([
      "canonical-thread",
      "canonical-thread",
    ]);
  });

  it("uses a canonical part thread before receipt and requested fallbacks", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          receipt: {
            platformMessageIds: ["m1"],
            parts: [{ platformMessageId: "m1", kind: "text", index: 0, threadId: "part-thread" }],
            threadId: "receipt-thread",
            sentAt: 123,
          },
        },
      ],
      threadId: "requested-thread",
    });

    expect(receipt.threadId).toBe("part-thread");
    expect(receipt.parts[0]?.threadId).toBe("part-thread");
  });

  it("keeps conflicting provider threads on parts and omits the aggregate thread", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          receipt: {
            platformMessageIds: ["m1"],
            parts: [{ platformMessageId: "m1", kind: "text", index: 0 }],
            threadId: "canonical-thread-1",
            sentAt: 123,
          },
        },
        {
          receipt: {
            platformMessageIds: ["m2"],
            parts: [{ platformMessageId: "m2", kind: "text", index: 0 }],
            threadId: "canonical-thread-2",
            sentAt: 124,
          },
        },
      ],
      threadId: "requested-thread",
    });

    expect(receipt.threadId).toBeUndefined();
    expect(receipt.parts.map((part) => part.threadId)).toEqual([
      "canonical-thread-1",
      "canonical-thread-2",
    ]);
  });

  it("preserves mixed nested reply metadata when the route has a reply target", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "discord",
          messageId: "m2",
          receipt: {
            primaryPlatformMessageId: "m1",
            platformMessageIds: ["m1", "m2"],
            parts: [
              { platformMessageId: "m1", kind: "text", index: 0, replyToId: "reply-1" },
              { platformMessageId: "m2", kind: "text", index: 1 },
            ],
            replyToId: "reply-1",
            sentAt: 123,
          },
        },
      ],
      replyToId: "reply-1",
    });

    expect(receipt.replyToId).toBe("reply-1");
    expect(receipt.parts.map((part) => part.replyToId)).toEqual(["reply-1", undefined]);
  });

  it("normalizes receipt ids for compatibility edges", () => {
    const receipt = {
      primaryPlatformMessageId: " ",
      platformMessageIds: [" m1 ", "", "m1", "m2"],
      parts: [],
      sentAt: 123,
    };

    expect(listMessageReceiptPlatformIds(receipt)).toEqual(["m1", "m2"]);
    expect(resolveMessageReceiptPrimaryId(receipt)).toBe("m1");
  });
});
