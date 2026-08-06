import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  resolveTelegramMessageCachePersistentScopeKey,
  TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES,
} from "./message-cache-persistence.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
  resolveProviderObservedTelegramThreadId,
} from "./message-cache.js";
import { resetTelegramMessageCacheForTest as resetCache } from "./runtime.test-support.js";

type PersistentStore = NonNullable<
  NonNullable<Parameters<typeof createTelegramMessageCache>[0]>["persistentStore"]
>;
type Cache = ReturnType<typeof createTelegramMessageCache>;
type ReplyChain = Awaited<ReturnType<typeof replyChain>>;
type PersistedValue = {
  version: 1;
  sourceMessage: Message;
  botUserId?: number;
  promptContextProjection?: unknown;
  threadBinding?: { kind: "provider-observed-v1"; threadId: string };
  threadId?: string;
};

let persistentStoreId = 0;

function createMemoryStore(maxEntries = TELEGRAM_MESSAGE_CACHE_PERSISTENT_MAX_MESSAGES) {
  const entries = new Map<string, PersistedValue>();
  return {
    bucketKey: `test:${process.pid}:${Date.now()}:${persistentStoreId++}`,
    entries,
    store: {
      async register(key, value) {
        entries.delete(key);
        entries.set(key, structuredClone(value));
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          entries.delete(oldest);
        }
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({ key, value: structuredClone(value) }));
      },
    } satisfies PersistentStore,
  };
}

const sender = (id: number, first_name: string, is_bot = false) => ({ id, is_bot, first_name });

function message(message_id: number, firstName: string, overrides: Record<string, unknown> = {}) {
  const { chat, date, from, ...rest } = overrides;
  return {
    chat: chat ?? { id: 7, type: "private", first_name: firstName },
    message_id,
    date: date ?? 1_736_371_600 + message_id,
    from: from ?? sender(1, firstName),
    ...rest,
  } as Message;
}

function photo(file_id: string) {
  return [{ file_id, file_unique_id: `${file_id}-unique`, width: 640, height: 480 }];
}

function botMessage(messageId: number, text: string, overrides: Record<string, unknown> = {}) {
  return message(messageId, "OpenClaw", {
    text,
    from: sender(999, "OpenClaw", true),
    ...overrides,
  });
}

function record(cache: Cache, msg: Message, overrides: Record<string, unknown> = {}) {
  return cache.record({ accountId: "default", chatId: 7, msg, ...overrides } as never);
}

function get(cache: Cache, messageId: string, overrides: Record<string, unknown> = {}) {
  return cache.get({ accountId: "default", chatId: 7, messageId, ...overrides } as never);
}

function reloadGet(bucketKey: string, store: PersistentStore, messageId: string) {
  resetCache();
  return get(cacheFor(bucketKey, store), messageId);
}

function recentBefore(cache: Cache, messageId: string, overrides: Record<string, unknown> = {}) {
  return cache.recentBefore({
    accountId: "default",
    chatId: 7,
    messageId,
    limit: 10,
    ...overrides,
  } as never);
}

const replyChain = (cache: Cache, msg: Message, chatId = 7) =>
  buildTelegramReplyChain({ cache, accountId: "default", chatId, msg });

const cacheFor = (bucketKey: string, persistentStore: PersistentStore) =>
  createTelegramMessageCache({ bucketKey, persistentStore });

function entryStore(store: PersistentStore, key: string, value: unknown): PersistentStore {
  return {
    register: (nextKey, nextValue) => store.register(nextKey, nextValue),
    entries: async () => [{ key, value }],
  } as PersistentStore;
}

function conversationContext(cache: Cache, messageId: string, replyChainNodes: ReplyChain) {
  return buildTelegramConversationContext({
    cache,
    accountId: "default",
    chatId: 7,
    messageId,
    replyChainNodes,
    recentLimit: 10,
    replyTargetWindowSize: 2,
  });
}

function onlyEntry(entries: Map<string, PersistedValue>): [string, PersistedValue] {
  const entry = entries.entries().next().value;
  if (!entry) {
    throw new Error("expected persisted Telegram message cache value");
  }
  return entry;
}

const projection = (transcriptMessageId: string) => ({
  transcriptMessageId,
  partIndex: 0,
  finalPart: true,
});

describe("telegram message cache", () => {
  it("persists provider-observed topic bindings for messages and same-topic replies", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const forum = { id: -1001, type: "supergroup", title: "QA", is_forum: true };
    const parent = message(901, "Ada", {
      chat: forum,
      date: 1_736_380_701,
      text: "Parent",
      from: sender(1, "Ada"),
    });
    const cache = cacheFor(bucketKey, store);
    await record(
      cache,
      message(902, "Grace", {
        chat: forum,
        date: 1_736_380_702,
        text: "Reply",
        from: sender(2, "Grace"),
        message_thread_id: 77,
        is_topic_message: true,
        reply_to_message: parent,
      }),
      { chatId: -1001, threadId: 77, providerObservedThreadId: 77 },
    );

    expect(entries.size).toBe(2);
    expect(
      Array.from(entries.values()).every(
        (value) =>
          value.threadBinding?.kind === "provider-observed-v1" &&
          value.threadBinding.threadId === "77",
      ),
    ).toBe(true);

    resetCache();
    const reloaded = cacheFor(bucketKey, store);
    for (const messageId of ["901", "902"]) {
      const node = await get(reloaded, messageId, { chatId: -1001 });
      expect(hasProviderObservedTelegramThreadBinding(node, 77)).toBe(true);
      expect(resolveProviderObservedTelegramThreadId(node)).toBe(77);
    }
  });

  it("does not resolve caller-only topic metadata as a provider-observed binding", async () => {
    const cache = createTelegramMessageCache();
    await record(
      cache,
      message(903, "Ada", {
        chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
        message_thread_id: 77,
        is_topic_message: true,
      }),
      { chatId: -1001, threadId: 77 },
    );

    const node = await get(cache, "903", { chatId: -1001 });
    expect(resolveProviderObservedTelegramThreadId(node)).toBeUndefined();
  });

  it("hydrates reply chains from persisted cached messages", async () => {
    const { bucketKey, store } = createMemoryStore();
    const photoMessage = message(9000, "Kesava", {
      date: 1_736_380_700,
      photo: photo("photo-1"),
    });
    const reply = message(9001, "Ada", {
      date: 1_736_380_750,
      text: "The cache warmer is the piece I meant",
      from: sender(2, "Ada"),
      reply_to_message: photoMessage,
    });
    const firstCache = cacheFor(bucketKey, store);
    await record(firstCache, photoMessage);
    await record(firstCache, reply);

    resetCache();
    const secondCache = cacheFor(bucketKey, store);
    const chain = await replyChain(
      secondCache,
      message(9002, "Grace", {
        text: "Please explain what this reply was about",
        from: sender(3, "Grace"),
        reply_to_message: message(9001, "Ada", {
          date: 1_736_380_750,
          text: "The cache warmer is the piece I meant",
          from: sender(2, "Ada"),
        }),
      }),
    );

    expect(chain).toEqual([
      {
        messageId: "9001",
        sender: "Ada",
        senderId: "2",
        timestamp: 1736380750000,
        body: "The cache warmer is the piece I meant",
        replyToId: "9000",
        sourceMessage: reply,
      },
      {
        messageId: "9000",
        sender: "Kesava",
        senderId: "1",
        timestamp: 1736380700000,
        mediaRef: "telegram:file/photo-1",
        mediaType: "image",
        sourceMessage: photoMessage,
      },
    ]);
  });

  it("records embedded reply targets as normal cached messages", async () => {
    const { bucketKey, store } = createMemoryStore();
    const chat = { id: 7, type: "group", title: "Ops" };
    const imageReply = message(101, "Bot", {
      chat,
      date: 1_736_380_700,
      text: "Done, here is the image",
      from: sender(999, "Bot", true),
      photo: photo("generated-photo-1"),
    });
    const userReply = message(102, "UserB", {
      chat,
      date: 1_736_380_750,
      text: "Why is there a 4th person?",
      from: sender(2, "UserB"),
      reply_to_message: imageReply,
    });
    const firstCache = cacheFor(bucketKey, store);
    await record(firstCache, userReply);

    resetCache();
    const secondCache = cacheFor(bucketKey, store);
    const chain = await replyChain(
      secondCache,
      message(103, "UserA", {
        chat,
        date: 1_736_380_800,
        text: "Explain what went wrong",
        reply_to_message: message(102, "UserB", {
          chat,
          date: 1_736_380_750,
          text: "Why is there a 4th person?",
          from: sender(2, "UserB"),
        }),
      }),
    );
    const context = await conversationContext(secondCache, "103", chain);

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
    const chat = { id: 7, type: "group", title: "Ops" };
    const photoFields = { chat, from: sender(999, "Bot", true), photo: photo("generated-photo-2") };
    await record(
      cache,
      message(104, "Bot", { ...photoFields, date: 1_736_380_900, caption: "old caption" }),
    );
    const updated = await record(
      cache,
      message(104, "Bot", { ...photoFields, date: 1_736_380_900, edit_date: 1_736_380_910 }),
    );

    expect(updated).toMatchObject({
      messageId: "104",
      mediaType: "image",
      mediaRef: "telegram:file/generated-photo-2",
    });
    expect(updated.body).toBeUndefined();
    expect(updated?.body).not.toBe("old caption");
  });

  it("shares one persisted bucket across live cache instances", async () => {
    const { bucketKey, store } = createMemoryStore();
    const [firstCache, secondCache] = [cacheFor(bucketKey, store), cacheFor(bucketKey, store)];
    const nora = message(9100, "Nora", { text: "Architecture sketch for the cache warmer" });
    const ira = message(9101, "Ira", {
      text: "The cache warmer is the piece I meant",
      from: sender(2, "Ira"),
      reply_to_message: nora,
    });
    await record(firstCache, nora);
    await record(secondCache, ira);
    const chain = await replyChain(
      cacheFor(bucketKey, store),
      message(9102, "Mina", {
        text: "Please explain what this reply was about",
        from: sender(3, "Mina"),
        reply_to_message: message(9101, "Ira", {
          text: "The cache warmer is the piece I meant",
          from: sender(2, "Ira"),
        }),
      }),
    );

    expect(chain.map((entry) => entry.messageId)).toEqual(["9101", "9100"]);
  });

  it("persists cached records through the plugin state store", async () => {
    const { bucketKey, store } = createMemoryStore(3);
    const cache = cacheFor(bucketKey, store);
    for (let index = 0; index < 5; index++) {
      await record(
        cache,
        message(9120 + index, "Nora", {
          date: 1_736_380_700 + index,
          text: `State message ${index}`,
        }),
      );
    }

    resetCache();
    const recent = await recentBefore(cacheFor(bucketKey, store), "9125");
    expect(recent.map((entry) => entry.messageId)).toEqual(["9122", "9123", "9124"]);
  });

  it("persists prompt-context projection provenance across cache restart", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const marker = projection("assistant-projection-restart");
    const cache = cacheFor(bucketKey, store);
    await record(cache, botMessage(9125, "Projection-aware state message"), {
      promptContextProjection: marker,
    });

    expect(entries.values().next().value).toMatchObject({
      version: 1,
      promptContextProjection: marker,
    });

    resetCache();
    const reloadedCache = cacheFor(bucketKey, store);
    const reloaded = await get(reloadedCache, "9125");
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });

    const edited = await record(
      reloadedCache,
      botMessage(9125, "Edited projection-aware state message", { edit_date: 1_736_380_730 }),
    );
    expect(edited).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection: marker },
    });

    const editedReloaded = await reloadGet(bucketKey, store, "9125");
    expect(editedReloaded).toMatchObject({
      body: "Edited projection-aware state message",
      promptContextProjectionMarker: { kind: "valid", projection: marker },
    });

    const malformedStore = entryStore(store, entries.keys().next().value!, {
      ...entries.values().next().value,
      promptContextProjection: { ...marker, partIndex: -1 },
    });
    resetCache();
    const malformedCache = cacheFor(bucketKey, malformedStore);
    const malformed = await get(malformedCache, "9125");
    expect(malformed?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: marker.transcriptMessageId,
    });

    await record(
      malformedCache,
      botMessage(9125, "Edited malformed projection state message", { edit_date: 1_736_380_731 }),
    );
    expect(entries.values().next().value?.promptContextProjection).toEqual({
      transcriptMessageId: marker.transcriptMessageId,
    });

    const malformedReloaded = await reloadGet(bucketKey, store, "9125");
    expect(malformedReloaded?.promptContextProjectionMarker).toEqual({
      kind: "invalid",
      transcriptMessageId: marker.transcriptMessageId,
    });
  });

  it("recognizes projected messages sent on behalf of a Telegram Business account", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const marker = projection("assistant-business-projection");
    const businessMessage = message(9128, "Business User", {
      text: "Business reply",
      from: sender(700, "Business User"),
      sender_business_bot: sender(42, "OpenClaw", true),
    });
    const cache = cacheFor(bucketKey, store);
    const live = await record(cache, businessMessage, {
      botUserId: 42,
      promptContextProjection: marker,
    });
    expect(live.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });
    expect(entries.values().next().value).toMatchObject({ botUserId: 42 });

    const reloaded = await reloadGet(bucketKey, store, "9128");
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });

    const [persistedKey, persistedValue] = onlyEntry(entries);
    entries.set(persistedKey, { ...persistedValue, botUserId: 99 });
    const mismatched = await reloadGet(bucketKey, store, "9128");
    expect(mismatched?.promptContextProjectionMarker).toBeUndefined();
  });

  it("preserves projected message whitespace across cache restart", async () => {
    const { bucketKey, store } = createMemoryStore();
    const marker = projection("assistant-whitespace-projection");
    const text = "  indented\nnext  \n";
    const cache = cacheFor(bucketKey, store);
    const live = await record(
      cache,
      message(9132, "OpenClaw", { text, from: sender(42, "OpenClaw", true) }),
      {
        botUserId: 42,
        promptContextProjection: marker,
      },
    );
    expect(live.body).toBe(text);

    const reloaded = await reloadGet(bucketKey, store, "9132");
    expect(reloaded?.body).toBe(text);
    expect(reloaded?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });
  });

  it("poisons projection provenance when its durable cache write fails", async () => {
    const bucketKey = `test:${process.pid}:${Date.now()}:${persistentStoreId++}`;
    const persistentStore: PersistentStore = {
      async register() {
        throw new Error("state store unavailable");
      },
      async entries() {
        return [];
      },
    };
    const cache = cacheFor(bucketKey, persistentStore);
    await expect(
      record(cache, message(9126, "Nora", { text: "Markerless context" })),
    ).resolves.toMatchObject({ messageId: "9126" });

    const marker = projection("assistant-persistence-failure");
    await expect(
      record(cache, botMessage(9127, "Projected context"), { promptContextProjection: marker }),
    ).rejects.toThrow("state store unavailable");
    await expect(get(cache, "9127")).resolves.toMatchObject({
      promptContextProjectionMarker: {
        kind: "invalid",
        transcriptMessageId: marker.transcriptMessageId,
      },
    });
  });

  it.each([
    ["projected row first", ["projected", "parent"]],
    ["embedding parent first", ["parent", "projected"]],
  ])("keeps projected bot provenance when hydrating $0", async (_name, order) => {
    const { bucketKey, entries, store } = createMemoryStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    const marker = projection("assistant-embedded-order");
    const bot = botMessage(9130, "Projected answer");
    const values: Record<string, [string, PersistedValue]> = {
      projected: [
        `${scopeKey}:default:7:9130`,
        { version: 1, sourceMessage: bot, promptContextProjection: marker },
      ],
      parent: [
        `${scopeKey}:default:7:9131`,
        {
          version: 1,
          sourceMessage: message(9131, "Nora", {
            text: "Replying to the answer",
            reply_to_message: bot,
          }),
        },
      ],
    };
    for (const name of order) {
      const [key, value] = values[name]!;
      entries.set(key, value);
    }

    const hydrated = await get(cacheFor(bucketKey, store), "9130");
    expect(hydrated?.promptContextProjectionMarker).toEqual({ kind: "valid", projection: marker });
  });

  it("ignores persisted projection metadata on inbound messages", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    entries.set(`${scopeKey}:default:7:9140`, {
      version: 1,
      sourceMessage: message(9140, "Nora", { text: "Inbound text" }),
      promptContextProjection: projection("must-not-be-trusted"),
    });

    const hydrated = await get(cacheFor(bucketKey, store), "9140");
    expect(hydrated?.promptContextProjectionMarker).toBeUndefined();
  });

  it("hydrates unversioned pre-projection rows without inferring provenance", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const cache = cacheFor(bucketKey, store);
    await record(cache, botMessage(9126, "Pre-projection state message"));
    const [persistedKey, persistedValue] = onlyEntry(entries);
    const legacyStore = entryStore(store, persistedKey, {
      sourceMessage: persistedValue.sourceMessage,
      promptContextProjection: projection("must-not-be-inferred"),
      threadBinding: { kind: "provider-observed-v1", threadId: "77" },
      threadId: "77",
    });

    resetCache();
    const reloaded = await get(cacheFor(bucketKey, legacyStore), "9126");
    expect(reloaded).toMatchObject({
      body: "Pre-projection state message",
      messageId: "9126",
    });
    expect(reloaded?.promptContextProjectionMarker).toBeUndefined();
    expect(hasProviderObservedTelegramThreadBinding(reloaded, 77)).toBe(false);
    expect(resolveProviderObservedTelegramThreadId(reloaded)).toBeUndefined();
  });

  it("rejects unknown future persisted cache versions", async () => {
    const { bucketKey, store } = createMemoryStore();
    const scopeKey = resolveTelegramMessageCachePersistentScopeKey("default");
    const futureStore = entryStore(store, `${scopeKey}:default:7:9127`, {
      version: 2,
      sourceMessage: message(9127, "Nora", {
        chat: { id: 7, type: "group", title: "Ops" },
        text: "Future state message",
      }),
    });

    const cache = cacheFor(bucketKey, futureStore);
    expect(await get(cache, "9127")).toBeNull();
  });

  it("does not partially parse malformed persisted thread ids", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const cache = cacheFor(bucketKey, store);
    await record(
      cache,
      message(9126, "Nora", {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        date: 1_736_389_126,
        text: "State topic message",
      }),
      { threadId: 100 },
    );

    const [persistedKey, persistedValue] = onlyEntry(entries);
    expect(persistedValue.threadId).toBe("100");
    entries.set(persistedKey, { ...persistedValue, threadId: "0x64" });

    resetCache();
    const recent = await recentBefore(cacheFor(bucketKey, store), "9127", { threadId: 100 });
    expect(recent).toEqual([]);
  });

  it("drops unsafe Telegram thread ids from live messages", async () => {
    const { bucketKey, entries, store } = createMemoryStore();
    const cache = cacheFor(bucketKey, store);
    await record(
      cache,
      message(9127, "Nora", {
        chat: { id: 7, type: "supergroup", title: "Ops" },
        date: 1_736_389_127,
        message_thread_id: Number.MAX_SAFE_INTEGER + 1,
        text: "Unsafe topic message",
      }),
    );

    const [, persistedValue] = onlyEntry(entries);
    expect(persistedValue.threadId).toBeUndefined();
    const topicRecent = await recentBefore(cache, "9128", {
      threadId: Number.MAX_SAFE_INTEGER + 1,
    });
    const unscopedRecent = await recentBefore(cache, "9128");

    expect(topicRecent).toEqual([]);
    expect(unscopedRecent.map((entry) => entry.messageId)).toEqual(["9127"]);
  });

  it("does not use unsafe message ids as recent-before cutoffs", async () => {
    const cache = createTelegramMessageCache();
    await record(cache, message(9124, "Nora", { date: 1_736_380_700, text: "State message" }));
    const recent = await recentBefore(cache, "9007199254740992");

    expect(recent).toEqual([]);
  });
});
