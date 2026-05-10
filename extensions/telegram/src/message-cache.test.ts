import { readFile, rm } from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import { describe, expect, it, vi } from "vitest";
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

      vi.resetModules();
      const reloaded = await import("./message-cache.js");
      const secondCache = reloaded.createTelegramMessageCache({ persistedPath });
      const chain = reloaded.buildTelegramReplyChain({
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

  it("appends cached records between compactions and reloads the bounded cache window", async () => {
    const storePath = `/tmp/openclaw-telegram-message-cache-append-${process.pid}-${Date.now()}.json`;
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    await rm(persistedPath, { force: true });
    try {
      const cache = createTelegramMessageCache({ persistedPath, maxMessages: 4 });
      for (let index = 0; index < 5; index++) {
        cache.record({
          accountId: "default",
          chatId: 7,
          msg: {
            chat: { id: 7, type: "private", first_name: "Nora" },
            message_id: 9150 + index,
            date: 1736380700 + index,
            text: `Message ${index}`,
            from: { id: 1, is_bot: false, first_name: "Nora" },
          } as Message,
        });
      }

      const lines = (await readFile(persistedPath, "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(5);

      vi.resetModules();
      const reloaded = await import("./message-cache.js");
      const reloadedCache = reloaded.createTelegramMessageCache({ persistedPath, maxMessages: 4 });
      expect(reloadedCache.get({ accountId: "default", chatId: 7, messageId: "9150" })).toBeNull();
      expect(
        reloadedCache.get({ accountId: "default", chatId: 7, messageId: "9151" })?.messageId,
      ).toBe("9151");
    } finally {
      await rm(persistedPath, { force: true });
    }
  });

  it("keeps the persisted log bounded by compacting cached records", async () => {
    const storePath = `/tmp/openclaw-telegram-message-cache-compact-${process.pid}-${Date.now()}.json`;
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    await rm(persistedPath, { force: true });
    try {
      const cache = createTelegramMessageCache({ persistedPath, maxMessages: 3 });
      for (let index = 0; index < 7; index++) {
        cache.record({
          accountId: "default",
          chatId: 7,
          msg: {
            chat: { id: 7, type: "private", first_name: "Nora" },
            message_id: 9200 + index,
            date: 1736380700 + index,
            text: `Message ${index}`,
            from: { id: 1, is_bot: false, first_name: "Nora" },
          } as Message,
        });
      }

      const lines = (await readFile(persistedPath, "utf-8")).trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(
        lines.map((line) => {
          const entry = JSON.parse(line) as {
            node: { sourceMessage: { message_id: number } };
          };
          return entry.node.sourceMessage.message_id;
        }),
      ).toEqual([9204, 9205, 9206]);
    } finally {
      await rm(persistedPath, { force: true });
    }
  });

  it("returns recent chat messages before the current message", () => {
    const cache = createTelegramMessageCache();
    for (const id of [41, 42, 43, 44]) {
      cache.record({
        accountId: "default",
        chatId: 7,
        threadId: 100,
        msg: {
          chat: { id: 7, type: "supergroup", title: "Ops" },
          message_thread_id: 100,
          message_id: id,
          date: 1736380700 + id,
          text: `live message ${id}`,
          from: { id, is_bot: false, first_name: `User ${id}` },
        } as Message,
      });
    }
    cache.record({
      accountId: "default",
      chatId: 7,
      threadId: 200,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        message_thread_id: 200,
        message_id: 142,
        date: 1736380743,
        text: "different topic",
        from: { id: 99, is_bot: false, first_name: "Other" },
      } as Message,
    });

    expect(
      cache
        .recentBefore({
          accountId: "default",
          chatId: 7,
          threadId: 100,
          messageId: "44",
          limit: 2,
        })
        .map((entry) => entry.messageId),
    ).toEqual(["42", "43"]);
  });

  it("returns nearby messages around a stale reply target", () => {
    const cache = createTelegramMessageCache();
    for (const id of [100, 101, 102, 200, 201]) {
      cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380700 + id,
          text: `message ${id}`,
          from: { id, is_bot: false, first_name: `User ${id}` },
        } as Message,
      });
    }

    expect(
      cache
        .around({
          accountId: "default",
          chatId: 7,
          messageId: "101",
          before: 1,
          after: 1,
        })
        .map((entry) => entry.messageId),
    ).toEqual(["100", "101", "102"]);
  });
});
