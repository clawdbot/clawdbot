import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { describeReplyTarget } from "./bot/helpers.js";

vi.mock("./sticker-vision.runtime.js", () => ({
  resolveStickerVisionSupportRuntime: vi.fn(async () => false),
}));

describe("buildTelegramMessageContext media carriers", () => {
  it("keeps reply media structured before reply-chain rendering", () => {
    const target = describeReplyTarget({
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: 42, type: "private", first_name: "Ada" },
      from: { id: 42, is_bot: false, first_name: "Ada" },
      reply_to_message: {
        message_id: 10,
        date: 1_699_999_999,
        chat: { id: 42, type: "private", first_name: "Pat" },
        from: { id: 7, is_bot: false, first_name: "Pat" },
        photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
      },
    } as unknown as Message);

    expect(target).toMatchObject({ mediaType: "image", sender: "Pat" });
    expect(target?.body).toBeUndefined();
  });

  it("renders cached native media kinds in reply-chain text", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: "What was that?",
      },
      replyChain: [
        {
          messageId: "9",
          sender: "Pat",
          mediaType: "image",
        },
      ],
    });

    expect(context?.ctxPayload.Body).toContain("[Reply chain - nearest first]");
    expect(context?.ctxPayload.Body).toContain("<media:image>");
  });

  it("keeps native sticker kind ahead of its materialized image MIME", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: "What was that?",
      },
      replyChain: [
        {
          messageId: "10",
          sender: "Pat",
          mediaKind: "sticker",
          mediaType: "image/webp",
        },
      ],
    });

    expect(context?.ctxPayload.Body).toContain("<media:sticker>");
    expect(context?.ctxPayload.Body).not.toContain("<media:image>");
  });

  it("uses only the immediate reply media for ReplyToBody", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: "What was that?",
      },
      replyChain: [
        { messageId: "10", sender: "Pat", mediaType: "image", replyToId: "9" },
        { messageId: "9", sender: "Sam", mediaType: "document" },
      ],
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("<media:image>");
    expect(context?.ctxPayload.Body).toContain("<media:document>");
  });

  it("keeps the native reply kind when a cached chain is filtered out", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        from: { id: 1, is_bot: false, first_name: "Ada" },
        text: "What was that?",
        reply_to_message: {
          message_id: 10,
          date: 1_699_999_999,
          chat: { id: -1001, type: "supergroup", title: "Ops" },
          from: { id: 1, is_bot: false, first_name: "Ada" },
          photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
        },
      },
      cfg: {
        channels: { telegram: { groupPolicy: "allowlist", contextVisibility: "allowlist" } },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1"] },
        topicConfig: undefined,
      }),
      replyChain: [{ messageId: "10", sender: "Hidden", senderId: "999", mediaType: "image" }],
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("<media:image>");
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["image"]);
  });

  it("keeps primary media bodies empty while recording formatted group history", async () => {
    const groupHistories = new Map();
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        text: undefined,
        photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
      },
      allMedia: [{ kind: "image" }],
      groupHistories,
      historyLimit: 5,
    });

    expect(context?.ctxPayload.RawBody).toBe("");
    expect(context?.ctxPayload.BodyForAgent).toBe("");
    expect(context?.ctxPayload.CommandBody).toBe("");
    expect(context?.ctxPayload.CommandSource).toBeUndefined();
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["image"]);
    expect([...groupHistories.values()].flat().at(-1)?.body).toBe("<media:image>");
  });

  it("admits an unavailable native sticker as a type-only fact", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: undefined,
        sticker: {
          file_id: "sticker-1",
          file_unique_id: "sticker-u1",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: true,
          is_video: false,
        },
      },
      allMedia: [{ kind: "sticker" }],
    });

    expect(context?.ctxPayload.RawBody).toBe("");
    expect(context?.ctxPayload.BodyForAgent).toBe("");
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["sticker"]);
    expect(context?.ctxPayload.StickerMediaIncluded).toBeUndefined();
  });

  it("preserves cached sticker descriptions in group history", async () => {
    const groupHistories = new Map();
    await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1002, type: "supergroup", title: "Stickers" },
        text: undefined,
        sticker: {
          file_id: "sticker-2",
          file_unique_id: "sticker-u2",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
        },
      },
      allMedia: [
        {
          kind: "sticker",
          path: "/tmp/sticker.webp",
          contentType: "image/webp",
          stickerMetadata: { cachedDescription: "A waving sticker" },
        },
      ],
      groupHistories,
      historyLimit: 5,
    });

    expect([...groupHistories.values()].flat().at(-1)?.body).toBe("[Sticker] A waving sticker");
  });
});
