import { readFile, rm, writeFile } from "node:fs/promises";
import type { Message } from "@grammyjs/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  resetTelegramMessageCacheBucketsForTest,
  resolveTelegramMessageCachePath,
} from "./message-cache.js";

type PersistedCacheEntry = {
  key: string;
  node: {
    sourceMessage: Message;
  };
};

function persistedCacheEntry(messageId: number, text: string): PersistedCacheEntry {
  return {
    key: `default:7:${messageId}`,
    node: {
      sourceMessage: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: messageId,
        date: 1736380000 + messageId,
        text,
        from: { id: messageId, is_bot: false, first_name: `User ${messageId}` },
      } as Message,
    },
  };
}

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

      resetTelegramMessageCacheBucketsForTest();
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
        {
          messageId: "9001",
          sender: "Ada",
          senderId: "2",
          timestamp: 1736380750000,
          body: "The cache warmer is the piece I meant",
          replyToId: "9000",
          sourceMessage: {
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
            },
          },
        },
        {
          messageId: "9000",
          sender: "Kesava",
          senderId: "1",
          timestamp: 1736380700000,
          mediaRef: "telegram:file/photo-1",
          mediaType: "image",
          body: "<media:image>",
          sourceMessage: {
            chat: { id: 7, type: "private", first_name: "Kesava" },
            message_id: 9000,
            date: 1736380700,
            from: { id: 1, is_bot: false, first_name: "Kesava" },
            photo: [
              { file_id: "photo-1", file_unique_id: "photo-unique-1", width: 640, height: 480 },
            ],
          },
        },
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

      resetTelegramMessageCacheBucketsForTest();
      const reloadedCache = createTelegramMessageCache({ persistedPath, maxMessages: 4 });
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

  it("loads mixed legacy array caches and rewrites them as line-delimited entries", async () => {
    const storePath = `/tmp/openclaw-telegram-message-cache-legacy-${process.pid}-${Date.now()}.json`;
    const persistedPath = resolveTelegramMessageCachePath(storePath);
    await rm(persistedPath, { force: true });
    try {
      const legacyEntries = [
        persistedCacheEntry(35033, "ocdbg-5818 one"),
        persistedCacheEntry(35034, "ocdbg-5818 two"),
        persistedCacheEntry(35035, "ocdbg-5818 three"),
      ];
      const appendedEntries = [
        persistedCacheEntry(35036, "ocdbg-5818 four"),
        persistedCacheEntry(35037, "ocdbg-5818 five"),
      ];
      await writeFile(
        persistedPath,
        `${JSON.stringify(legacyEntries)}${appendedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );

      const cache = createTelegramMessageCache({ persistedPath });

      expect(
        cache
          .around({
            accountId: "default",
            chatId: 7,
            messageId: "35035",
            before: 2,
            after: 2,
          })
          .map((entry) => entry.messageId),
      ).toEqual(["35033", "35034", "35035", "35036", "35037"]);

      const canonical = await readFile(persistedPath, "utf-8");
      expect(canonical.startsWith("[")).toBe(false);
      const lines = canonical.trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(
        lines.map((line) => {
          const entry = JSON.parse(line) as PersistedCacheEntry;
          return entry.node.sourceMessage.message_id;
        }),
      ).toEqual([35033, 35034, 35035, 35036, 35037]);
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

  it("selects reply targets referenced by the current local window", () => {
    const cache = createTelegramMessageCache();
    for (const id of [33867, 33868, 33869]) {
      cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380000 + id,
          text: `old context ${id}`,
          from: { id, is_bot: false, first_name: `Old ${id}` },
        } as Message,
      });
    }
    for (let id = 34460; id <= 34475; id++) {
      cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: id,
          date: 1736380000 + id,
          text: `recent context ${id}`,
          from: { id, is_bot: false, first_name: `Recent ${id}` },
        } as Message,
      });
    }
    cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: 34476,
        date: 1736380000 + 34476,
        text: "@HamVerBot what about now",
        from: { id: 34476, is_bot: false, first_name: "Ayaan" },
        reply_to_message: {
          chat: { id: 7, type: "group", title: "Ops" },
          message_id: 33868,
          date: 1736380000 + 33868,
          text: "old context 33868",
          from: { id: 33868, is_bot: false, first_name: "Old 33868" },
        } as Message["reply_to_message"],
      } as Message,
    });
    cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "group", title: "Ops" },
        message_id: 34477,
        date: 1736380000 + 34477,
        text: "Show me raw input",
        from: { id: 34477, is_bot: false, first_name: "Ayaan" },
      } as Message,
    });

    const context = buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "34477",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual([
      "33867",
      "33868",
      "33869",
      "34467",
      "34468",
      "34469",
      "34470",
      "34471",
      "34472",
      "34473",
      "34474",
      "34475",
      "34476",
    ]);
    expect(context.find((entry) => entry.node.messageId === "33868")?.isReplyTarget).toBe(true);
    expect(context.find((entry) => entry.node.messageId === "34477")).toBeUndefined();
  });

  it("does not select messages before the latest session reset command", () => {
    const cache = createTelegramMessageCache();
    const beforeSession = Date.parse("2026-05-10T12:40:00.000Z");
    const sessionStartedAt = Date.parse("2026-05-10T17:30:43.980Z");
    const afterSession = Date.parse("2026-05-11T23:36:00.000Z");
    const staleInstruction = "okay so we just flip in openclaw? if yes do it up";
    const record = (params: {
      id: number;
      text: string;
      timestampMs: number;
      replyTo?: { id: number; text: string; timestampMs: number };
    }) =>
      cache.record({
        accountId: "default",
        chatId: 7,
        threadId: 22534,
        msg: {
          chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
          message_thread_id: 22534,
          message_id: params.id,
          date: Math.floor(params.timestampMs / 1000),
          text: params.text,
          from: { id: params.id, is_bot: false, first_name: "Requester" },
          ...(params.replyTo
            ? {
                reply_to_message: {
                  chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
                  message_thread_id: 22534,
                  message_id: params.replyTo.id,
                  date: Math.floor(params.replyTo.timestampMs / 1000),
                  text: params.replyTo.text,
                  from: { id: params.replyTo.id, is_bot: false, first_name: "Requester" },
                } as Message["reply_to_message"],
              }
            : {}),
        } as Message,
      });

    record({ id: 84669, text: "earlier topic setup", timestampMs: beforeSession - 1000 });
    record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    record({ id: 84671, text: "old reply context", timestampMs: beforeSession + 1000 });
    record({ id: 85000, text: "/new", timestampMs: sessionStartedAt });
    record({
      id: 87183,
      text: "post-reset context",
      timestampMs: afterSession - 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    });
    record({ id: 87184, text: "how does this determine stability?", timestampMs: afterSession });

    const replyChainNodes = buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
        message_thread_id: 22534,
        message_id: 87185,
        date: Math.floor(afterSession / 1000) + 30,
        text: "follow up",
        from: { id: 87185, is_bot: false, first_name: "Requester" },
        reply_to_message: {
          chat: { id: 7, type: "supergroup", title: "Ops", is_forum: true },
          message_thread_id: 22534,
          message_id: 84670,
          date: Math.floor(beforeSession / 1000),
          text: staleInstruction,
          from: { id: 84670, is_bot: false, first_name: "Requester" },
        } as Message["reply_to_message"],
      } as Message,
    });

    const context = buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "87185",
      threadId: 22534,
      replyChainNodes,
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["87183", "87184"]);
    expect(context.map((entry) => entry.node.body)).not.toContain(staleInstruction);
  });

  it("does not select messages before the persisted session start when the reset command is absent", () => {
    const cache = createTelegramMessageCache();
    const beforeSession = Date.parse("2026-05-10T12:40:00.000Z");
    const sessionStartedAt = Date.parse("2026-05-10T17:30:43.127Z");
    const afterSession = Date.parse("2026-05-11T23:36:00.000Z");
    const staleInstruction = "okay so we just flip in openclaw? if yes do it up";
    const record = (params: {
      id: number;
      text: string;
      timestampMs: number;
      replyTo?: { id: number; text: string; timestampMs: number };
    }) =>
      cache.record({
        accountId: "default",
        chatId: -1001234567890,
        threadId: 22534,
        msg: {
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Ops",
            is_forum: true,
          },
          message_thread_id: 22534,
          message_id: params.id,
          date: Math.floor(params.timestampMs / 1000),
          text: params.text,
          from: { id: 101, is_bot: false, first_name: "Requester" },
          ...(params.replyTo
            ? {
                reply_to_message: {
                  chat: {
                    id: -1001234567890,
                    type: "supergroup",
                    title: "Ops",
                    is_forum: true,
                  },
                  message_thread_id: 22534,
                  message_id: params.replyTo.id,
                  date: Math.floor(params.replyTo.timestampMs / 1000),
                  text: params.replyTo.text,
                  from: { id: 101, is_bot: false, first_name: "Requester" },
                } as Message["reply_to_message"],
              }
            : {}),
        } as Message,
      });

    record({
      id: 84649,
      text: "tools.toolSearch: true",
      timestampMs: beforeSession - 5 * 60_000,
    });
    record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    record({ id: 87184, text: "how does this determine stability?", timestampMs: afterSession });
    const current = record({
      id: 87227,
      text: "what config change?",
      timestampMs: afterSession + 2 * 60 * 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    })?.sourceMessage;
    if (!current) {
      throw new Error("expected current Telegram message");
    }

    const replyChainNodes = buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: -1001234567890,
      msg: current,
    });
    const context = buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: -1001234567890,
      messageId: "87227",
      threadId: 22534,
      replyChainNodes,
      recentLimit: 10,
      replyTargetWindowSize: 1,
      minTimestampMs: sessionStartedAt,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["87184"]);
    expect(context.map((entry) => entry.node.body)).not.toContain(staleInstruction);
    expect(context.map((entry) => entry.node.body)).not.toContain("tools.toolSearch: true");
  });
});
