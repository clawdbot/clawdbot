import { rm } from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramReplyChain,
  createTelegramMessageCache,
  resolveTelegramMessageCachePath,
} from "./message-cache.js";

describe("telegram message cache", () => {
  it("hydrates reply chains from persisted cached messages", async () => {
    const storePath = `/tmp/openclaw-telegram-message-cache-${process.pid}-${Date.now()}.json`;
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    await rm(persistedPath, { force: true });
    try {
      const firstCache = createTelegramMessageCache({ persistedPath });
      firstCache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Kesava" },
          message_id: 9000,
          date: 1736380700,
          from: { id: 1, is_bot: false, first_name: "Kesava" },
          photo: [
            { file_id: "photo-1", file_unique_id: "photo-unique-1", width: 640, height: 480 },
          ],
        } as Message,
      });
      firstCache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Ada" },
          message_id: 9001,
          date: 1736380750,
          text: "The cache warmer is the piece I meant",
          from: { id: 2, is_bot: false, first_name: "Ada" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Kesava" },
            message_id: 9000,
            date: 1736380700,
            from: { id: 1, is_bot: false, first_name: "Kesava" },
            photo: [
              { file_id: "photo-1", file_unique_id: "photo-unique-1", width: 640, height: 480 },
            ],
          } as Message["reply_to_message"],
        } as Message,
      });

      const secondCache = createTelegramMessageCache({ persistedPath });
      const chain = buildTelegramReplyChain({
        cache: secondCache,
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Grace" },
          message_id: 9002,
          text: "Please explain what this reply was about",
          from: { id: 3, is_bot: false, first_name: "Grace" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Ada" },
            message_id: 9001,
            date: 1736380750,
            text: "The cache warmer is the piece I meant",
            from: { id: 2, is_bot: false, first_name: "Ada" },
          } as Message["reply_to_message"],
        } as Message,
      });

      expect(chain).toEqual([
        expect.objectContaining({
          messageId: "9001",
          body: "The cache warmer is the piece I meant",
          replyToId: "9000",
        }),
        expect.objectContaining({
          messageId: "9000",
          mediaRef: "telegram:file/photo-1",
          mediaType: "image",
        }),
      ]);
    } finally {
      await rm(persistedPath, { force: true });
    }
  });

  it("shares one persisted bucket across live cache instances", async () => {
    const storePath = `/tmp/openclaw-telegram-message-cache-shared-${process.pid}-${Date.now()}.json`;
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    await rm(persistedPath, { force: true });
    try {
      const firstCache = createTelegramMessageCache({ persistedPath });
      const secondCache = createTelegramMessageCache({ persistedPath });
      firstCache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Nora" },
          message_id: 9100,
          date: 1736380700,
          text: "Architecture sketch for the cache warmer",
          from: { id: 1, is_bot: false, first_name: "Nora" },
        } as Message,
      });
      secondCache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Ira" },
          message_id: 9101,
          date: 1736380750,
          text: "The cache warmer is the piece I meant",
          from: { id: 2, is_bot: false, first_name: "Ira" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Nora" },
            message_id: 9100,
            date: 1736380700,
            text: "Architecture sketch for the cache warmer",
            from: { id: 1, is_bot: false, first_name: "Nora" },
          } as Message["reply_to_message"],
        } as Message,
      });

      const reloadedCache = createTelegramMessageCache({ persistedPath });
      const chain = buildTelegramReplyChain({
        cache: reloadedCache,
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Mina" },
          message_id: 9102,
          text: "Please explain what this reply was about",
          from: { id: 3, is_bot: false, first_name: "Mina" },
          reply_to_message: {
            chat: { id: 7, type: "private", first_name: "Ira" },
            message_id: 9101,
            date: 1736380750,
            text: "The cache warmer is the piece I meant",
            from: { id: 2, is_bot: false, first_name: "Ira" },
          } as Message["reply_to_message"],
        } as Message,
      });

      expect(chain.map((entry) => entry.messageId)).toEqual(["9101", "9100"]);
    } finally {
      await rm(persistedPath, { force: true });
    }
  });
});
