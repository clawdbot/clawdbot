// Telegram tests cover message cache plugin behavior.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
} from "./message-cache.js";
import { resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest } from "./runtime.test-support.js";

type TelegramMessageCachePersistentStore = NonNullable<
  NonNullable<Parameters<typeof createTelegramMessageCache>[0]>["persistentStore"]
>;

type PersistedCacheValue = {
  version: 1;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: unknown;
  threadBinding?: { kind: "provider-observed-v1"; threadId: string };
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
  it("persists provider-observed topic bindings for messages and same-topic replies", async () => {
    const { bucketKey, entries, store } = createMemoryPersistentStore();
    const cache = createTelegramMessageCache({ bucketKey, persistentStore: store });
    await cache.record({
      accountId: "default",
      chatId: -1001,
      threadId: 77,
      providerObservedThreadId: 77,
      msg: {
        chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
        message_id: 902,
        message_thread_id: 77,
        is_topic_message: true,
        date: 1_736_380_702,
        text: "Reply",
        from: { id: 2, is_bot: false, first_name: "Grace" },
        reply_to_message: {
          chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
          message_id: 901,
          date: 1_736_380_701,
          text: "Parent",
          from: { id: 1, is_bot: false, first_name: "Ada" },
        } as Message["reply_to_message"],
      } as Message,
    });

    expect(entries.size).toBe(2);
    expect(
      Array.from(entries.values()).every(
        (value) =>
          value.threadBinding?.kind === "provider-observed-v1" &&
          value.threadBinding.threadId === "77",
      ),
    ).toBe(true);

    resetTelegramMessageCacheBucketsForTest();
    const reloaded = createTelegramMessageCache({ bucketKey, persistentStore: store });
    for (const messageId of ["901", "902"]) {
      const node = await reloaded.get({ accountId: "default", chatId: -1001, messageId });
      expect(hasProviderObservedTelegramThreadBinding(node, 77)).toBe(true);
    }
  });

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
      mediaType: "image",
      mediaRef: "telegram:file/generated-photo-2",
    });
    expect(updated.body).toBeUndefined();
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
      threadBinding: { kind: "provider-observed-v1", threadId: "77" },
      threadId: "77",
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
    expect(hasProviderObservedTelegramThreadBinding(reloaded, 77)).toBe(false);
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
});
