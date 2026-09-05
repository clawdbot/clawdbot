import type { Message } from "grammy/types";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { resolveTelegramMessageCachePersistentScopeKey } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

type Cache = ReturnType<typeof createTelegramMessageCache>;
type CacheOptions = NonNullable<Parameters<typeof createTelegramMessageCache>[0]>;
type MessageStore = NonNullable<CacheOptions["persistentStore"]>;
type PrivacyStore = NonNullable<CacheOptions["privacyStore"]>;

let storeId = 0;

function createStore(maxEntries = 3000) {
  const values = new Map<string, unknown>();
  const store = {
    async register(key: string, value: unknown) {
      values.delete(key);
      values.set(key, structuredClone(value));
      while (values.size > maxEntries) {
        const oldest = values.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        values.delete(oldest);
      }
    },
    async lookup(key: string) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values, ([key, value]) => ({ key, value: structuredClone(value) }));
    },
  } as MessageStore & PrivacyStore;
  return { bucketKey: `privacy-test:${storeId++}`, store };
}

function message(messageId: number, text: string, overrides: Partial<Message> = {}): Message {
  return {
    message_id: messageId,
    date: 1_736_371_600 + messageId,
    chat: { id: 7, type: "private", first_name: "Test" },
    from: { id: 1, is_bot: false, first_name: "Ada" },
    text,
    ...overrides,
  } as Message;
}

function photo(fileId: string) {
  return [{ file_id: fileId, file_unique_id: `${fileId}-unique`, width: 1, height: 1 }];
}

function record(cache: Cache, msg: Message) {
  return cache.record({ accountId: "default", chatId: 7, msg });
}

function get(cache: Cache, messageId: string) {
  return cache.get({ accountId: "default", chatId: 7, messageId });
}

describe("telegram message-cache privacy state", () => {
  it("revokes live reply context before privacy persistence settles", async () => {
    const messageState = createStore();
    const privacyState = createStore();
    const cache = createTelegramMessageCache({
      bucketKey: messageState.bucketKey,
      persistentStore: messageState.store,
      privacyStore: privacyState.store,
    });
    const hidden = message(927, "private detail");
    const reply = message(928, "ordinary reply", {
      reply_to_message: hidden as NonNullable<Message["reply_to_message"]>,
      quote: { text: "private detail", position: 0 },
    });
    await record(cache, hidden);
    await record(cache, reply);

    const enteredPersistence = createDeferred<void>();
    const releasePersistence = createDeferred<void>();
    const registerPrivacy = privacyState.store.register.bind(privacyState.store);
    privacyState.store.register = async (key, value) => {
      enteredPersistence.resolve();
      await releasePersistence.promise;
      await registerPrivacy(key, value);
    };
    const removal = cache.remove({ accountId: "default", chatId: 7, messageId: "927" });
    await enteredPersistence.promise;

    try {
      await expect(get(cache, "927")).resolves.toBeNull();
      const liveReply = await get(cache, "928");
      expect(liveReply?.replyToId).toBeUndefined();
      expect(liveReply?.sourceMessage.reply_to_message).toBeUndefined();
      expect(liveReply?.sourceMessage.quote).toBeUndefined();
    } finally {
      releasePersistence.resolve();
      await removal;
    }
  });

  it("fails closed when authoritative privacy state cannot hydrate", async () => {
    const messageState = createStore();
    const privacyState = createStore();
    await messageState.store.register("ignored-without-readable-privacy:7:1", {
      version: 1,
      sourceMessage: message(1, "private detail"),
    });
    privacyState.store.entries = async () => {
      throw new Error("privacy store unavailable");
    };
    const cache = createTelegramMessageCache({
      bucketKey: messageState.bucketKey,
      persistentStore: messageState.store,
      privacyStore: privacyState.store,
    });

    await expect(get(cache, "1")).rejects.toThrow("privacy store unavailable");
  });

  it("applies an album tombstone authoritatively regardless of hydration order", async () => {
    const messageState = createStore();
    const privacyState = createStore();
    const createCache = () =>
      createTelegramMessageCache({
        bucketKey: messageState.bucketKey,
        persistentStore: messageState.store,
        privacyStore: privacyState.store,
      });
    const cache = createCache();
    const hidden = message(929, "", {
      caption: "private album member",
      media_group_id: "ignored-album-hydration-order",
      photo: photo("ignored-hydration-order"),
    });
    const reply = message(930, "ordinary reply", {
      reply_to_message: hidden as NonNullable<Message["reply_to_message"]>,
      quote: { text: "private album member", position: 0 },
    });
    await record(cache, hidden);
    await record(cache, reply);
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    await messageState.store.register(`${scopeKey}:ignored-media-group:hydration-order`, {
      version: 1,
      kind: "ignored-media-group",
      accountId: "default",
      chatId: "7",
      mediaGroupId: "ignored-album-hydration-order",
    });

    resetTelegramMessageCacheForTest();
    const restarted = createCache();
    await expect(get(restarted, "929")).resolves.toBeNull();
    const restartedReply = await get(restarted, "930");
    expect(restartedReply?.replyToId).toBeUndefined();
    expect(restartedReply?.sourceMessage.reply_to_message).toBeUndefined();
    expect(restartedReply?.sourceMessage.quote).toBeUndefined();
  });

  it("does not resurrect a direct ignore after command policy or bot identity changes", async () => {
    const messageState = createStore();
    const privacyState = createStore();
    const createCache = (overrides: Partial<CacheOptions> = {}) =>
      createTelegramMessageCache({
        bucketKey: messageState.bucketKey,
        persistentStore: messageState.store,
        privacyStore: privacyState.store,
        ...overrides,
      });
    const cache = createCache();
    await record(cache, message(931, "private detail"));
    await cache.remove({ accountId: "default", chatId: 7, messageId: "931" });

    resetTelegramMessageCacheForTest();
    const restarted = createCache({ ignoreEnabled: false, botUsername: "renamed_bot" });
    await record(restarted, message(931, "ordinary-looking replay"));
    await expect(get(restarted, "931")).resolves.toBeNull();
  });

  it("keeps privacy tombstones independent from ordinary reply-cache eviction", async () => {
    const messageState = createStore(2);
    const privacyState = createStore(8);
    const createCache = () =>
      createTelegramMessageCache({
        bucketKey: messageState.bucketKey,
        persistentStore: messageState.store,
        privacyStore: privacyState.store,
      });
    const cache = createCache();
    const hidden = message(932, "", {
      caption: "private album member",
      media_group_id: "ignored-album-independent-lru",
      photo: photo("ignored-independent-lru"),
    });
    await record(cache, hidden);
    await cache.remove({
      accountId: "default",
      chatId: 7,
      messageId: "932",
      mediaGroupId: "ignored-album-independent-lru",
    });
    for (let messageId = 933; messageId <= 936; messageId += 1) {
      await record(cache, message(messageId, `routine ${messageId}`));
    }

    resetTelegramMessageCacheForTest();
    const restarted = createCache();
    await record(
      restarted,
      message(937, "ordinary reply", {
        reply_to_message: hidden as NonNullable<Message["reply_to_message"]>,
        quote: { text: "private album member", position: 0 },
      }),
    );
    const recordedReply = await get(restarted, "937");
    expect(recordedReply?.replyToId).toBeUndefined();
    expect(recordedReply?.sourceMessage.reply_to_message).toBeUndefined();
    expect(recordedReply?.sourceMessage.quote).toBeUndefined();
  });
});
