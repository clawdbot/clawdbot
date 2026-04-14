import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTopicNameCache,
  getTopicEntry,
  getTopicName,
  topicNameCacheSize,
  updateTopicName,
} from "./topic-name-cache.js";

describe("topic-name-cache", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearTopicNameCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves a topic name", () => {
    updateTopicName(-100123, 42, { name: "Deployments" });
    expect(getTopicName(-100123, 42)).toBe("Deployments");
  });

  it("returns undefined for unknown topics", () => {
    expect(getTopicName(-100123, 99)).toBeUndefined();
  });

  it("handles renames via forum_topic_edited (overwrites previous name)", () => {
    updateTopicName(-100123, 42, { name: "Deployments" });
    updateTopicName(-100123, 42, { name: "CI/CD" });
    expect(getTopicName(-100123, 42)).toBe("CI/CD");
  });

  it("preserves name when patching only closed status", () => {
    updateTopicName(-100123, 42, { name: "Deployments" });
    updateTopicName(-100123, 42, { closed: true });
    expect(getTopicName(-100123, 42)).toBe("Deployments");
    expect(getTopicEntry(-100123, 42)?.closed).toBe(true);
  });

  it("marks topic as reopened", () => {
    updateTopicName(-100123, 42, { name: "Deployments", closed: true });
    updateTopicName(-100123, 42, { closed: false });
    expect(getTopicEntry(-100123, 42)?.closed).toBe(false);
  });

  it("stores icon metadata", () => {
    updateTopicName(-100123, 42, {
      name: "Design",
      iconColor: 0x6fb9f0,
      iconCustomEmojiId: "emoji123",
    });
    const entry = getTopicEntry(-100123, 42);
    expect(entry?.iconColor).toBe(0x6fb9f0);
    expect(entry?.iconCustomEmojiId).toBe("emoji123");
  });

  it("does not store entries with empty name and no prior entry", () => {
    updateTopicName(-100123, 42, { closed: true });
    expect(getTopicName(-100123, 42)).toBeUndefined();
    expect(topicNameCacheSize()).toBe(0);
  });

  it("updates timestamps on write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T22:00:00.000Z"));
    updateTopicName(-100123, 42, { name: "A" });
    const t1 = getTopicEntry(-100123, 42)?.updatedAt ?? 0;
    await vi.advanceTimersByTimeAsync(10);
    updateTopicName(-100123, 42, { name: "B" });
    const t2 = getTopicEntry(-100123, 42)?.updatedAt ?? 0;
    expect(t2).toBeGreaterThan(t1);
  });

  it("works with string chatId and threadId", () => {
    updateTopicName("-100123", "42", { name: "StringKeys" });
    expect(getTopicName("-100123", "42")).toBe("StringKeys");
  });

  it("evicts the oldest entry when cache exceeds 2048", () => {
    for (let i = 0; i < 2049; i++) {
      updateTopicName(-100000, i, { name: `Topic ${i}` });
    }
    expect(topicNameCacheSize()).toBe(2048);
    expect(getTopicName(-100000, 0)).toBeUndefined();
    expect(getTopicName(-100000, 2048)).toBe("Topic 2048");
  });

  it("refreshes recency on read so active topics survive eviction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T22:00:00.000Z"));
    updateTopicName(-100000, 1, { name: "Active" });
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 2; i <= 2048; i++) {
      updateTopicName(-100000, i, { name: `Topic ${i}` });
    }
    getTopicName(-100000, 1);
    updateTopicName(-100000, 9999, { name: "Newcomer" });
    expect(getTopicName(-100000, 1)).toBe("Active");
    expect(topicNameCacheSize()).toBe(2048);
  });
});
