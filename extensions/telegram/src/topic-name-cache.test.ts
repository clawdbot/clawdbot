// Telegram tests cover topic name cache plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTopicNameCache,
  getTopicEntry,
  getTopicName,
  resetTopicNameCacheForTest,
  setTelegramTopicNameStoreFactoryForTest,
  topicNameCacheSize,
  updateTopicName,
} from "./topic-name-cache.js";

type TopicEntry = NonNullable<Awaited<ReturnType<typeof getTopicEntry>>>;

function installMemoryStores() {
  const stores = new Map<string, Map<string, TopicEntry>>();
  setTelegramTopicNameStoreFactoryForTest((namespace) => {
    const entries = stores.get(namespace) ?? new Map<string, TopicEntry>();
    stores.set(namespace, entries);
    return {
      async register(key, value) {
        entries.set(key, value);
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({ key, value }));
      },
      async delete(key) {
        return entries.delete(key);
      },
      async clear() {
        entries.clear();
      },
    };
  });
  return stores;
}

describe("topic-name-cache", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    installMemoryStores();
    await clearTopicNameCache();
    resetTopicNameCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    setTelegramTopicNameStoreFactoryForTest(undefined);
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
    expect((await getTopicEntry(-100123, 42))?.closed).toBe(true);
  });

  it("marks topic as reopened", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments", closed: true });
    await updateTopicName(-100123, 42, { closed: false });
    expect((await getTopicEntry(-100123, 42))?.closed).toBe(false);
  });

  it("stores icon metadata", async () => {
    await updateTopicName(-100123, 42, {
      name: "Design",
      iconColor: 0x6fb9f0,
      iconCustomEmojiId: "emoji123",
    });
    const entry = await getTopicEntry(-100123, 42);
    expect(entry?.iconColor).toBe(0x6fb9f0);
    expect(entry?.iconCustomEmojiId).toBe("emoji123");
  });

  it("does not store entries with empty name and no prior entry", async () => {
    await updateTopicName(-100123, 42, { closed: true });
    await expect(getTopicName(-100123, 42)).resolves.toBeUndefined();
    expect(topicNameCacheSize()).toBe(0);
  });

  it("updates timestamps on write", async () => {
    vi.useFakeTimers();
    await updateTopicName(-100123, 42, { name: "A" });
    const t1 = (await getTopicEntry(-100123, 42))?.updatedAt ?? 0;
    await vi.advanceTimersByTimeAsync(10);
    await updateTopicName(-100123, 42, { name: "B" });
    const t2 = (await getTopicEntry(-100123, 42))?.updatedAt ?? 0;
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
    expect(topicNameCacheSize()).toBe(2048);
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
    expect(topicNameCacheSize()).toBe(2048);
  });

  it("reloads persisted entries from plugin state", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    resetTopicNameCacheForTest();
    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
  });

  it("keeps separate stores for separate scopes", async () => {
    await updateTopicName(-100123, 42, { name: "Deployments" }, "first");
    await updateTopicName(-200456, 84, { name: "Incidents" }, "second");

    await expect(getTopicName(-100123, 42, "first")).resolves.toBe("Deployments");
    await expect(getTopicName(-200456, 84, "second")).resolves.toBe("Incidents");
  });
});
