import { rm, writeFile } from "node:fs/promises";
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  listTelegramLegacyMessageCacheEntries,
  resetTelegramMessageCacheBucketsForTest,
  resolveTelegramMessageCachePath,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
  type TelegramMessageCachePersistentStore,
} from "./message-cache.js";

type PersistedCacheEntry = {
  key: string;
  node: {
    sourceMessage: Message;
  };
};

type PersistedCacheValue = {
  sourceMessage: Message;
  threadId?: string;
};

let persistentStoreId = 0;

function createMemoryPersistentStore(maxEntries = TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES): {
  bucketKey: string;
  entries: Map<string, PersistedCacheValue>;
  store: TelegramMessageCachePersistentStore;
} {
  const entries = new Map<string, PersistedCacheValue>();
  return {
    bucketKey: `test:${process.pid}:${Date.now()}:${persistentStoreId++}`,
    entries,
    store: {
      async register(key, value) {
        entries.delete(key);
        entries.set(key, value);
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          entries.delete(oldest);
        }
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({ key, value }));
      },
    },
  };
}

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
    const { bucketKey, store } = createMemoryPersistentStore();
    const firstCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await firstCache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "Kesava" },
        message_id: 9000,
        date: 1736380700,
        from: { id: 1, is_bot: false, first_name: "Kesava" },
        photo: [{ file_id: "photo-1", file_unique_id: "photo-unique-1", width: 640, height: 480 }],
      } as Message,
    });
    await firstCache.record({
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
    const secondCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const chain = await buildTelegramReplyChain({
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
  });

  it("records embedded reply targets as normal cached messages", async () => {
    const { bucketKey, store } = createMemoryPersistentStore();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    const firstCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await firstCache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 102,
        date: 1736380750,
        text: "Why is there a 4th person?",
        from: { id: 2, is_bot: false, first_name: "UserB" },
        reply_to_message: {
          chat,
          message_id: 101,
          date: 1736380700,
          text: "Done, here is the image",
          from: { id: 999, is_bot: true, first_name: "Bot" },
          photo: [
            {
              file_id: "generated-photo-1",
              file_unique_id: "generated-photo-unique-1",
              width: 640,
              height: 480,
            },
          ],
        } as Message["reply_to_message"],
      } as Message,
    });

    resetTelegramMessageCacheBucketsForTest();
    const secondCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const current = {
      chat,
      message_id: 103,
      date: 1736380800,
      text: "Explain what went wrong",
      from: { id: 1, is_bot: false, first_name: "UserA" },
      reply_to_message: {
        chat,
        message_id: 102,
        date: 1736380750,
        text: "Why is there a 4th person?",
        from: { id: 2, is_bot: false, first_name: "UserB" },
      } as Message["reply_to_message"],
    } as Message;
    const chain = await buildTelegramReplyChain({
      cache: secondCache,
      accountId: "default",
      chatId: 7,
      msg: current,
    });
    const context = await buildTelegramConversationContext({
      cache: secondCache,
      accountId: "default",
      chatId: 7,
      messageId: "103",
      replyChainNodes: chain,
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(chain.map((entry) => entry.messageId)).toEqual(["102", "101"]);
    expect(chain[1]).toMatchObject({
      sender: "Bot",
      body: "Done, here is the image",
      mediaRef: "telegram:file/generated-photo-1",
    });
    expect(context.map((entry) => entry.node.messageId)).toEqual(["101", "102"]);
    expect(context.find((entry) => entry.node.messageId === "101")?.isReplyTarget).toBe(true);
  });

  it("replaces authoritative edited message fields without stale caption carryover", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 104,
        date: 1736380900,
        caption: "old caption",
        from: { id: 999, is_bot: true, first_name: "Bot" },
        photo: [
          {
            file_id: "generated-photo-2",
            file_unique_id: "generated-photo-unique-2",
            width: 640,
            height: 480,
          },
        ],
      } as Message,
    });

    const updated = await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 104,
        date: 1736380900,
        edit_date: 1736380910,
        from: { id: 999, is_bot: true, first_name: "Bot" },
        photo: [
          {
            file_id: "generated-photo-2",
            file_unique_id: "generated-photo-unique-2",
            width: 640,
            height: 480,
          },
        ],
      } as Message,
    });

    expect(updated).toMatchObject({
      messageId: "104",
      body: "<media:image>",
      mediaRef: "telegram:file/generated-photo-2",
    });
    expect(updated?.body).not.toBe("old caption");
  });

  it("shares one persisted bucket across live cache instances", async () => {
    const { bucketKey, store } = createMemoryPersistentStore();
    const firstCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const secondCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await firstCache.record({
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
    await secondCache.record({
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

    const reloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const chain = await buildTelegramReplyChain({
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
  });

  it("persists cached records through the plugin state store", async () => {
    const { bucketKey, store } = createMemoryPersistentStore(3);
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    for (let index = 0; index < 5; index++) {
      await cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Nora" },
          message_id: 9120 + index,
          date: 1736380700 + index,
          text: `State message ${index}`,
          from: { id: 1, is_bot: false, first_name: "Nora" },
        } as Message,
      });
    }

    resetTelegramMessageCacheBucketsForTest();
    const reloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const recent = await reloadedCache.recentBefore({
      accountId: "default",
      chatId: 7,
      messageId: "9125",
      limit: 10,
    });

    expect(recent.map((entry) => entry.messageId)).toEqual(["9122", "9123", "9124"]);
  });

  it("does not partially parse malformed persisted thread ids", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await cache.record({
      accountId: "default",
      chatId: 7,
      threadId: 100,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        message_id: 9126,
        date: 1736389126,
        text: "State topic message",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const persistedKey = entries.keys().next().value;
    if (persistedKey === undefined) {
      throw new Error("expected persisted Telegram message cache entry");
    }
    const persistedValue = entries.get(persistedKey);
    if (persistedValue === undefined) {
      throw new Error("expected persisted Telegram message cache value");
    }
    expect(persistedValue.threadId).toBe("100");
    entries.set(persistedKey, { ...persistedValue, threadId: "0x64" });

    resetTelegramMessageCacheBucketsForTest();
    const reloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const recent = await reloadedCache.recentBefore({
      accountId: "default",
      chatId: 7,
      threadId: 100,
      messageId: "9127",
      limit: 10,
    });

    expect(recent).toEqual([]);
  });

  it("drops unsafe Telegram thread ids from live messages", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        message_id: 9127,
        message_thread_id: Number.MAX_SAFE_INTEGER + 1,
        date: 1736389127,
        text: "Unsafe topic message",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const persistedValue = entries.values().next().value;
    if (persistedValue === undefined) {
      throw new Error("expected persisted Telegram message cache value");
    }
    expect(persistedValue.threadId).toBeUndefined();

    const topicRecent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      threadId: Number.MAX_SAFE_INTEGER + 1,
      messageId: "9128",
      limit: 10,
    });
    const unscopedRecent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      messageId: "9128",
      limit: 10,
    });

    expect(topicRecent).toEqual([]);
    expect(unscopedRecent.map((entry) => entry.messageId)).toEqual(["9127"]);
  });

  it("does not use unsafe message ids as recent-before cutoffs", async () => {
    const cache = createTelegramMessageCache();
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "Nora" },
        message_id: 9124,
        date: 1736380700,
        text: "State message",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const recent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      messageId: "9007199254740992",
      limit: 10,
    });

    expect(recent).toEqual([]);
  });

  it("parses legacy sidecar records for doctor migration only", async () => {
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

      expect(
        listTelegramLegacyMessageCacheEntries({ persistedPath }).map(
          (entry) => entry.value.sourceMessage.message_id,
        ),
      ).toEqual([35033, 35034, 35035, 35036, 35037]);
    } finally {
      await rm(persistedPath, { force: true });
    }
  });

  it("returns recent chat messages before the current message", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [41, 42, 43, 44]) {
      await cache.record({
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
    await cache.record({
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

    const recent = await cache.recentBefore({
      accountId: "default",
      chatId: 7,
      threadId: 100,
      messageId: "44",
      limit: 2,
    });
    expect(recent.map((entry) => entry.messageId)).toEqual(["42", "43"]);
  });

  it("returns nearby messages around a stale reply target", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [100, 101, 102, 200, 201]) {
      await cache.record({
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

    const nearby = await cache.around({
      accountId: "default",
      chatId: 7,
      messageId: "101",
      before: 1,
      after: 1,
    });
    expect(nearby.map((entry) => entry.messageId)).toEqual(["100", "101", "102"]);
  });

  it("selects reply targets referenced by the current local window", async () => {
    const cache = createTelegramMessageCache();
    for (const id of [33867, 33868, 33869]) {
      await cache.record({
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
      await cache.record({
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
    await cache.record({
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
    await cache.record({
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

    const context = await buildTelegramConversationContext({
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

  it("does not select messages before the latest session reset command", async () => {
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

    await record({ id: 84669, text: "earlier topic setup", timestampMs: beforeSession - 1000 });
    await record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    await record({ id: 84671, text: "old reply context", timestampMs: beforeSession + 1000 });
    await record({ id: 85000, text: "/new", timestampMs: sessionStartedAt });
    await record({
      id: 87183,
      text: "post-reset context",
      timestampMs: afterSession - 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    });
    await record({
      id: 87184,
      text: "how does this determine stability?",
      timestampMs: afterSession,
    });

    const replyChainNodes = await buildTelegramReplyChain({
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

    const context = await buildTelegramConversationContext({
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

  it("does not select messages before the persisted session start when the reset command is absent", async () => {
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

    await record({
      id: 84649,
      text: "tools.toolSearch: true",
      timestampMs: beforeSession - 5 * 60_000,
    });
    await record({ id: 84670, text: staleInstruction, timestampMs: beforeSession });
    await record({
      id: 87184,
      text: "how does this determine stability?",
      timestampMs: afterSession,
    });
    const currentNode = await record({
      id: 87227,
      text: "what config change?",
      timestampMs: afterSession + 2 * 60 * 60_000,
      replyTo: { id: 84670, text: staleInstruction, timestampMs: beforeSession },
    });
    const current = currentNode?.sourceMessage;
    if (!current) {
      throw new Error("expected current Telegram message");
    }

    const replyChainNodes = await buildTelegramReplyChain({
      cache,
      accountId: "default",
      chatId: -1001234567890,
      msg: current,
    });
    const context = await buildTelegramConversationContext({
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
