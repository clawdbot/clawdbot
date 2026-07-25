// Telegram tests cover topic name cache plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramTopicNameCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { getTopicName, updateTopicName } from "./topic-name-cache.js";

type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

function topicKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

function getStoredTopicEntry(
  stores: Map<string, Map<string, TopicEntry>>,
  chatId: number | string,
  threadId: number | string,
): TopicEntry | undefined {
  const key = topicKey(chatId, threadId);
  for (const entries of stores.values()) {
    const entry = entries.get(key);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

function topicStoreSize(stores: Map<string, Map<string, TopicEntry>>): number {
  return Array.from(stores.values(), (entries) => entries.size).reduce(
    (total, size) => total + size,
    0,
  );
}

function installMemoryStores() {
  const stores = new Map<string, Map<string, TopicEntry>>();
  setTelegramRuntime({
    state: {
      openKeyedStore: (({ namespace }: { namespace: string }) => {
        const entries = stores.get(namespace) ?? new Map<string, TopicEntry>();
        stores.set(namespace, entries);
        return {
          async register(key: string, value: TopicEntry) {
            entries.set(key, value);
          },
          async entries() {
            return Array.from(entries, ([key, value]) => ({ key, value }));
          },
          async delete(key: string) {
            return entries.delete(key);
          },
          async clear() {
            entries.clear();
          },
        };
      }) as unknown as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
  return stores;
}

describe("topic-name-cache", () => {
  let stores: Map<string, Map<string, TopicEntry>>;

  beforeEach(async () => {
    vi.useRealTimers();
    stores = installMemoryStores();
    resetTelegramTopicNameCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTelegramRuntimeForTest();
  });

  it("stores and retrieves a topic name", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" });
    await expect(getTopicName(-100123, 42)).resolves.toBe("Deployments");
  });

  it("returns undefined for unknown topics", async () => {
    await expect(getTopicName(-100123, 99)).resolves.toBeUndefined();
  });

  it("handles renames via forum_topic_edited", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" });
    await updateTopicName(-100123, 42, { name: "CI/CD" });
    await expect(getTopicName(-100123, 42)).resolves.toBe("CI/CD");
  });

  it("preserves name when patching only closed status", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" });
    await updateTopicName(-100123, 42, { closed: true });
    await expect(getTopicName(-100123, 42)).resolves.toBe("Deployments");
    expect(getStoredTopicEntry(stores, -100123, 42)?.closed).toBe(true);
  });

  it("marks topic as reopened", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments", closed: true });
    await updateTopicName(-100123, 42, { closed: false });
    expect(getStoredTopicEntry(stores, -100123, 42)?.closed).toBe(false);
  });

  it("stores icon metadata", async () => {
    await updateTopicName(-100123, 42, {
      name: "Design",
      iconColor: 0x6fb9f0,
      iconCustomEmojiId: "emoji123",
    });
    const entry = getStoredTopicEntry(stores, -100123, 42);
    expect(entry?.iconColor).toBe(0x6fb9f0);
    expect(entry?.iconCustomEmojiId).toBe("emoji123");
  });

  it("does not store entries with empty name and no prior entry", async () => {
    await updateTopicName(-100123, 42, { closed: true });
    await expect(getTopicName(-100123, 42)).resolves.toBeUndefined();
    expect(topicStoreSize(stores)).toBe(0);
  });

  it("updates timestamps on write", async () => {
    vi.useFakeTimers();
    await updateTopicName(-100123, 42, { name: "A" });
    const t1 = getStoredTopicEntry(stores, -100123, 42)?.updatedAt ?? 0;
    await vi.advanceTimersByTimeAsync(10);
    await updateTopicName(-100123, 42, { name: "B" });
    const t2 = getStoredTopicEntry(stores, -100123, 42)?.updatedAt ?? 0;
    expect(t2).toBeGreaterThan(t1);
  });

  it("works with string chatId and threadId", async () => {
    await updateTopicName("-100123", "42", { name: "StringKeys" });
    await expect(getTopicName("-100123", "42")).resolves.toBe("StringKeys");
  });

  it("evicts the oldest entry when cache exceeds 2048", async () => {
    for (let i = 0; i < 2049; i++) {
      await updateTopicName(-100000, i, { name: `Topic ${i}` });
    }
    expect(topicStoreSize(stores)).toBe(2048);
    await expect(getTopicName(-100000, 0)).resolves.toBeUndefined();
    await expect(getTopicName(-100000, 2048)).resolves.toBe("Topic 2048");
  });

  it("refreshes recency on read so active topics survive eviction", async () => {
    vi.useFakeTimers();
    await updateTopicName(-100000, 1, { name: "Active" });
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 2; i <= 2048; i++) {
      await updateTopicName(-100000, i, { name: `Topic ${i}` });
    }
    await getTopicName(-100000, 1);
    await updateTopicName(-100000, 9999, { name: "Newcomer" });
    await expect(getTopicName(-100000, 1)).resolves.toBe("Active");
    expect(topicStoreSize(stores)).toBe(2048);
  });

  it("reloads persisted entries from plugin state", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    resetTelegramTopicNameCacheForTest();
    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
  });

  it("keeps separate stores for separate scopes", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    await updateTopicName(-200456, 84, { name: "Incidents" }, "second");

    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
    await expect(getTopicName(-200456, 84, "second")).resolves.toBe("Incidents");
  });
});
