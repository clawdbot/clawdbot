// Telegram tests cover message cache plugin behavior.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { isTelegramHistoryEntryAfterAmbientWatermark } from "./group-history-window.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
} from "./message-cache.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
} from "./runtime.test-support.js";

type TelegramMessageCachePersistentStore = NonNullable<
  NonNullable<Parameters<typeof createTelegramMessageCache>[0]>["persistentStore"]
>;

type PersistedCacheValue = {
  version: 1;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: unknown;
  threadId?: string;
};

let persistentStoreId = 0;

function clonePersistedCacheValue(value: PersistedCacheValue): PersistedCacheValue {
  return structuredClone(value);
}

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
        entries.set(key, clonePersistedCacheValue(value));
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          entries.delete(oldest);
        }
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({
          key,
          value: clonePersistedCacheValue(value),
        }));
      },
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

  it("persists prompt-context projection provenance across cache restart", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const projection = {
      transcriptMessageId: "assistant-projection-restart",
      partIndex: 0,
      finalPart: true,
    };
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "Nora" },
        message_id: 9125,
        date: 1736380725,
        text: "Projection-aware state message",
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      } as Message,
      promptContextProjection: projection,
    });

    expect(entries.values().next().value).toMatchObject({
      version: 1,
      promptContextProjection: projection,
    });

    resetTelegramMessageCacheBucketsForTest();
    const reloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const reloaded = await reloadedCache.get({
      accountId: "default",
      chatId: 7,
      messageId: "9125",
    });

    expect(reloaded?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection,
    });

    const edited = await reloadedCache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "Nora" },
        message_id: 9125,
        date: 1736380725,
        edit_date: 1736380730,
        text: "Edited projection-aware state message",
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      } as Message,
    });
    expect(edited).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection },
    });

    resetTelegramMessageCacheBucketsForTest();
    const editedReloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const editedReloaded = await editedReloadedCache.get({
      accountId: "default",
      chatId: 7,
      messageId: "9125",
    });
    expect(editedReloaded).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection },
    });

    const malformedStore: TelegramMessageCachePersistentStore = {
      register: (key, value) => store.register(key, value),
      async entries() {
        return [
          {
            key: entries.keys().next().value!,
            value: {
              ...entries.values().next().value,
              promptContextProjection: {
                transcriptMessageId: projection.transcriptMessageId,
                partIndex: -1,
                finalPart: true,
              },
            },
          },
        ];
      },
    };
    resetTelegramMessageCacheBucketsForTest();
    const malformedCache = createTelegramMessageCache({
      bucketKey,
      persistentStore: malformedStore,
    });
    const malformed = await malformedCache.get({
      accountId: "default",
      chatId: 7,
      messageId: "9125",
    });
    expect(malformed?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: projection.transcriptMessageId,
    });

    await malformedCache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "Nora" },
        message_id: 9125,
        date: 1736380725,
        edit_date: 1736380731,
        text: "Edited malformed projection state message",
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      } as Message,
    });
    expect(entries.values().next().value?.promptContextProjection).toEqual({
      transcriptMessageId: projection.transcriptMessageId,
    });

    resetTelegramMessageCacheBucketsForTest();
    const malformedReloaded = await createTelegramMessageCache({
      bucketKey,
      persistentStore: store,
    }).get({ accountId: "default", chatId: 7, messageId: "9125" });
    expect(malformedReloaded?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: projection.transcriptMessageId,
    });
  });

  it("recognizes projected messages sent on behalf of a Telegram Business account", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const projection = {
      transcriptMessageId: "assistant-business-projection",
      partIndex: 0,
      finalPart: true,
    };
    const businessMessage = {
      chat: { id: 7, type: "private", first_name: "Business User" },
      message_id: 9128,
      date: 1736380728,
      text: "Business reply",
      from: { id: 700, is_bot: false, first_name: "Business User" },
      sender_business_bot: { id: 42, is_bot: true, first_name: "OpenClaw" },
    } as Message;
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });

    const live = await cache.record({
      accountId: "default",
      botUserId: 42,
      chatId: 7,
      msg: businessMessage,
      promptContextProjection: projection,
    });
    expect(live.promptContextProjectionMarker).toEqual({ kind: "valid", projection });
    expect(entries.values().next().value).toMatchObject({ botUserId: 42 });

    resetTelegramMessageCacheBucketsForTest();
    const reloaded = await createTelegramMessageCache({
      bucketKey,
      persistentStore: store,
    }).get({ accountId: "default", chatId: 7, messageId: "9128" });
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection });

    const persistedKey = entries.keys().next().value;
    const persistedValue = entries.values().next().value;
    if (!persistedKey || !persistedValue) {
      throw new Error("expected persisted Telegram Business cache value");
    }
    entries.set(persistedKey, { ...persistedValue, botUserId: 99 });
    resetTelegramMessageCacheBucketsForTest();
    const mismatched = await createTelegramMessageCache({
      bucketKey,
      persistentStore: store,
    }).get({ accountId: "default", chatId: 7, messageId: "9128" });
    expect(mismatched?.promptContextProjectionMarker).toBeUndefined();
  });

  it("preserves projected message whitespace across cache restart", async () => {
    const { bucketKey, store } = createMemoryPersistentStore();
    const projection = {
      transcriptMessageId: "assistant-whitespace-projection",
      partIndex: 0,
      finalPart: true,
    };
    const text = "  indented\nnext  \n";
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    const live = await cache.record({
      accountId: "default",
      botUserId: 42,
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "OpenClaw" },
        message_id: 9132,
        date: 1736380732,
        text,
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      } as Message,
      promptContextProjection: projection,
    });
    expect(live.body).toBe(text);

    resetTelegramMessageCacheBucketsForTest();
    const reloaded = await createTelegramMessageCache({
      bucketKey,
      persistentStore: store,
    }).get({ accountId: "default", chatId: 7, messageId: "9132" });
    expect(reloaded?.body).toBe(text);
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection });
  });

  it("poisons projection provenance when its durable cache write fails", async () => {
    const bucketKey = `test:${process.pid}:${Date.now()}:${persistentStoreId++}`;
    const persistentStore: TelegramMessageCachePersistentStore = {
      async register() {
        throw new Error("state store unavailable");
      },
      async entries() {
        return [];
      },
    };
    const cache = createTelegramMessageCache({ bucketKey, persistentStore });
    await expect(
      cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "Nora" },
          message_id: 9126,
          date: 1736380726,
          text: "Markerless context",
          from: { id: 1, is_bot: false, first_name: "Nora" },
        } as Message,
      }),
    ).resolves.toMatchObject({ messageId: "9126" });

    const projection = {
      transcriptMessageId: "assistant-persistence-failure",
      partIndex: 0,
      finalPart: true,
    };
    await expect(
      cache.record({
        accountId: "default",
        chatId: 7,
        msg: {
          chat: { id: 7, type: "private", first_name: "OpenClaw" },
          message_id: 9127,
          date: 1736380727,
          text: "Projected context",
          from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        } as Message,
        promptContextProjection: projection,
      }),
    ).rejects.toThrow("state store unavailable");
    await expect(
      cache.get({ accountId: "default", chatId: 7, messageId: "9127" }),
    ).resolves.toMatchObject({
      promptContextProjectionMarker: {
        kind: "invalid",
        transcriptMessageId: projection.transcriptMessageId,
      },
    });
  });

  it.each([
    ["projected row first", ["projected", "parent"]],
    ["embedding parent first", ["parent", "projected"]],
  ])("keeps projected bot provenance when hydrating $0", async (_name, order) => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    const projection = {
      transcriptMessageId: "assistant-embedded-order",
      partIndex: 0,
      finalPart: true,
    };
    const botMessage = {
      chat: { id: 7, type: "private", first_name: "OpenClaw" },
      message_id: 9130,
      date: 1736380730,
      text: "Projected answer",
      from: { id: 999, is_bot: true, first_name: "OpenClaw" },
    } as Message;
    const values: Record<string, [string, PersistedCacheValue]> = {
      projected: [
        `${scopeKey}:default:7:9130`,
        { version: 1, sourceMessage: botMessage, promptContextProjection: projection },
      ],
      parent: [
        `${scopeKey}:default:7:9131`,
        {
          version: 1,
          sourceMessage: {
            chat: { id: 7, type: "private", first_name: "Nora" },
            message_id: 9131,
            date: 1736380731,
            text: "Replying to the answer",
            from: { id: 1, is_bot: false, first_name: "Nora" },
            reply_to_message: botMessage as Message["reply_to_message"],
          } as Message,
        },
      ],
    };
    for (const name of order) {
      const [key, value] = values[name]!;
      entries.set(key, value);
    }

    const hydrated = await createTelegramMessageCache({ bucketKey, persistentStore: store }).get({
      accountId: "default",
      chatId: 7,
      messageId: "9130",
    });
    expect(hydrated?.promptContextProjectionMarker).toEqual({ kind: "valid", projection });
  });

  it("ignores persisted projection metadata on inbound messages", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    entries.set(`${scopeKey}:default:7:9140`, {
      version: 1,
      sourceMessage: {
        chat: { id: 7, type: "private", first_name: "Nora" },
        message_id: 9140,
        date: 1736380740,
        text: "Inbound text",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
      promptContextProjection: {
        transcriptMessageId: "must-not-be-trusted",
        partIndex: 0,
        finalPart: true,
      },
    });

    const hydrated = await createTelegramMessageCache({ bucketKey, persistentStore: store }).get({
      accountId: "default",
      chatId: 7,
      messageId: "9140",
    });
    expect(hydrated?.promptContextProjectionMarker).toBeUndefined();
  });

  it("hydrates unversioned pre-projection rows without inferring provenance", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat: { id: 7, type: "private", first_name: "OpenClaw" },
        message_id: 9126,
        date: 1736380726,
        text: "Pre-projection state message",
        from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      } as Message,
    });

    const persistedKey = entries.keys().next().value;
    const persistedValue = entries.values().next().value;
    if (!persistedKey || !persistedValue) {
      throw new Error("expected persisted Telegram message cache value");
    }
    const unversionedValue = {
      sourceMessage: persistedValue.sourceMessage,
      promptContextProjection: {
        transcriptMessageId: "must-not-be-inferred",
        partIndex: 0,
        finalPart: true,
      },
      ...(persistedValue.threadId ? { threadId: persistedValue.threadId } : {}),
    };
    const legacyStore: TelegramMessageCachePersistentStore = {
      register: (key, value) => store.register(key, value),
      async entries() {
        return [{ key: persistedKey, value: unversionedValue }];
      },
    };

    resetTelegramMessageCacheBucketsForTest();
    const reloadedCache = createTelegramMessageCache({ bucketKey, persistentStore: legacyStore });

    const reloaded = await reloadedCache.get({
      accountId: "default",
      chatId: 7,
      messageId: "9126",
    });
    expect(reloaded).toMatchObject({
      body: "Pre-projection state message",
      messageId: "9126",
    });
    expect(reloaded?.promptContextProjectionMarker).toBeUndefined();
  });

  it("rejects unknown future persisted cache versions", async () => {
    const { bucketKey, store } = createMemoryPersistentStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    const futureStore: TelegramMessageCachePersistentStore = {
      register: (key, value) => store.register(key, value),
      async entries() {
        return [
          {
            key: `${scopeKey}:default:7:9127`,
            value: {
              version: 2,
              sourceMessage: {
                chat: { id: 7, type: "group", title: "Ops" },
                message_id: 9127,
                date: 1736380727,
                text: "Future state message",
                from: { id: 1, is_bot: false, first_name: "Nora" },
              },
            },
          },
        ];
      },
    };

    const cache = createTelegramMessageCache({ bucketKey, persistentStore: futureStore });
    expect(await cache.get({ accountId: "default", chatId: 7, messageId: "9127" })).toBeNull();
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

  it("preserves rich-message placeholders in subsequent conversation context", async () => {
    // A runtime leaked by earlier suite files binds new caches to the
    // persistent keyed store; clear it so this cache stays instance-local.
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheBucketsForTest();
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "private", first_name: "Nora" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 45,
        date: 1736380745,
        rich_message: { blocks: [{ type: "paragraph" }] },
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 46,
        date: 1736380746,
        text: "What did I just send?",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "46",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context).toHaveLength(1);
    expect(context[0]?.node).toMatchObject({
      messageId: "45",
      body: "[unsupported Telegram rich_message received]",
    });
  });

  it("preserves rich-message text in subsequent conversation context", async () => {
    // A runtime leaked by earlier suite files binds new caches to the
    // persistent keyed store; clear it so this cache stays instance-local.
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheBucketsForTest();
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "private", first_name: "Nora" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 45,
        date: 1736380745,
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: "Forwarded cache text",
            },
          ],
        },
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 46,
        date: 1736380746,
        text: "What did I just send?",
        from: { id: 1, is_bot: false, first_name: "Nora" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "46",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context).toHaveLength(1);
    expect(context[0]?.node).toMatchObject({
      messageId: "45",
      body: "Forwarded cache text",
    });
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

  it("filters conversation context nodes when an include predicate is supplied", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    for (const msg of [
      {
        chat,
        message_id: 600,
        date: 1736380600,
        text: "ambient setup chatter",
        from: { id: 111, is_bot: false, first_name: "Requester" },
      },
      {
        chat,
        message_id: 601,
        date: 1736380660,
        text: "@openclaw_bot please check this",
        from: { id: 222, is_bot: false, first_name: "Operator" },
      },
      {
        chat,
        message_id: 602,
        date: 1736380720,
        text: "@openclaw_bot Hello",
        from: { id: 222, is_bot: false, first_name: "Operator" },
      },
    ] satisfies Message[]) {
      await cache.record({ accountId: "default", chatId: 7, msg });
    }

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "602",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
      includeNode: (node) => node.body?.includes("@openclaw_bot") === true,
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["601"]);
  });

  it("filters ambient transcript rows from cache-derived group context", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    const timestampMs = 1_700_000_000_000;
    for (const msg of [
      {
        chat,
        message_id: 10,
        date: timestampMs / 1000,
        text: "persisted ambient one",
        from: { id: 101, is_bot: false, first_name: "Sam" },
      },
      {
        chat,
        message_id: 11,
        date: (timestampMs + 1000) / 1000,
        text: "persisted ambient two",
        from: { id: 102, is_bot: false, first_name: "Lee" },
      },
      {
        chat,
        message_id: 12,
        date: (timestampMs + 2000) / 1000,
        text: "unpersisted gap",
        from: { id: 103, is_bot: false, first_name: "Mira" },
        reply_to_message: {
          chat,
          message_id: 11,
          date: (timestampMs + 1000) / 1000,
          text: "persisted ambient two",
          from: { id: 102, is_bot: false, first_name: "Lee" },
        } as Message["reply_to_message"],
      },
      {
        chat,
        message_id: 13,
        date: (timestampMs + 3000) / 1000,
        text: "@openclaw_bot what happened?",
        from: { id: 104, is_bot: false, first_name: "Pat" },
      },
    ] satisfies Message[]) {
      await cache.record({ accountId: "default", chatId: 7, msg });
    }

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "13",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
      includeNode: (node, flags) =>
        flags?.replyTarget === true ||
        isTelegramHistoryEntryAfterAmbientWatermark(node, {
          messageId: "11",
          timestampMs: timestampMs + 1000,
        }),
    });

    expect(context.map((entry) => entry.node.messageId)).toEqual(["11", "12"]);
    expect(context.find((entry) => entry.node.messageId === "11")?.isReplyTarget).toBe(true);
    expect(context.map((entry) => entry.node.body)).not.toContain("persisted ambient one");
    expect(context.map((entry) => entry.node.body)).toContain("unpersisted gap");
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

  it("uses the current reset command as the session boundary", async () => {
    const cache = createTelegramMessageCache();
    const chat = { id: 7, type: "group", title: "Ops" } as const;
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 100,
        date: 1736380800,
        text: "stale context",
        from: { id: 100, is_bot: false, first_name: "Requester" },
      } as Message,
    });
    await cache.record({
      accountId: "default",
      chatId: 7,
      msg: {
        chat,
        message_id: 101,
        date: 1736380860,
        text: "/new",
        from: { id: 101, is_bot: false, first_name: "Requester" },
      } as Message,
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: 7,
      messageId: "101",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 1,
    });

    expect(context).toEqual([]);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
