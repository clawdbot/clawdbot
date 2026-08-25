import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { describeReplyTarget } from "./bot/helpers.js";

vi.mock("./sticker-vision.runtime.js", () => ({
  resolveStickerVisionSupportRuntime: vi.fn(async () => false),
}));

describe("buildTelegramMessageContext media carriers", () => {
  it("carries direct tool policy into a topic-bound admitted turn", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
        message_thread_id: 7,
        is_topic_message: true,
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: {
          tools: { deny: ["write"] },
          toolsBySender: {
            "channel:telegram:42": { deny: ["exec"] },
          },
        },
        topicConfig: { agentId: "support" },
      }),
    });

    expect(context?.ctxPayload).toMatchObject({
      ConversationToolPolicy: { deny: ["exec"] },
    });
  });

  it("does not attach direct policy to group turns", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -42, type: "supergroup", title: "Ops" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        text: "hello",
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { tools: { deny: ["exec"] }, requireMention: false },
        topicConfig: undefined,
      }),
    });

    expect(context?.ctxPayload.ConversationToolPolicy).toBeUndefined();
  });

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

  it("explains an unavailable animated sticker without inventing a staged path", async () => {
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
      allMedia: [{ kind: "sticker", unavailableReason: "animated-sticker" }],
    });

    expect(context?.ctxPayload.RawBody).toBe("");
    expect(context?.ctxPayload.BodyForAgent).toContain(
      "OpenClaw did not stage or analyze this animated Telegram sticker",
    );
    expect(context?.ctxPayload.media?.map((fact) => fact.kind)).toEqual(["sticker"]);
    expect(context?.ctxPayload.media?.[0]?.path).toBeUndefined();
    expect(context?.ctxPayload.StickerMediaIncluded).toBeUndefined();
  });

  it("explains unavailable hydrated reply stickers in reply context", async () => {
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
          mediaUnavailableReason: "video-sticker",
        },
      ],
    });

    expect(context?.ctxPayload.ReplyToBody).toContain(
      "OpenClaw did not stage or analyze this video Telegram sticker",
    );
  });

  it("explains unavailable ancestor stickers in the rendered reply chain", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        text: "What was that?",
      },
      replyChain: [
        {
          messageId: "11",
          replyToId: "10",
          sender: "Pat",
          body: "The sticker above",
        },
        {
          messageId: "10",
          sender: "Lee",
          mediaKind: "sticker",
          mediaUnavailableReason: "animated-sticker",
        },
      ],
    });

    expect(context?.ctxPayload.ReplyToBody).toBe("The sticker above");
    expect(context?.ctxPayload.Body).toContain(
      "OpenClaw did not stage or analyze this animated Telegram sticker",
    );
  });

  it("preserves unavailable sticker notices in accepted group history", async () => {
    const groupHistories = new Map();
    await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1003, type: "supergroup", title: "Stickers" },
        text: undefined,
        sticker: {
          file_id: "sticker-3",
          file_unique_id: "sticker-u3",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: false,
          is_video: true,
        },
      },
      allMedia: [{ kind: "sticker", unavailableReason: "video-sticker" }],
      groupHistories,
      historyLimit: 5,
    });

    const historyBody = [...groupHistories.values()].flat().at(-1)?.body;
    expect(historyBody).toContain("OpenClaw did not stage or analyze this video Telegram sticker");
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
