import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheSticker,
  getAllCachedStickers,
  getCachedSticker,
  getCacheStats,
  searchStickers,
} from "./sticker-cache.js";

// Mock the state directory to use a temp location
vi.mock("../config/paths.js", () => ({
  STATE_DIR: "/tmp/moltbot-test-sticker-cache",
}));

const TEST_CACHE_DIR = "/tmp/moltbot-test-sticker-cache/telegram";
const TEST_CACHE_FILE = path.join(TEST_CACHE_DIR, "sticker-cache.json");

describe("sticker-cache", () => {
  beforeEach(() => {
    // Clean up before each test
    if (fs.existsSync(TEST_CACHE_FILE)) {
      fs.unlinkSync(TEST_CACHE_FILE);
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(TEST_CACHE_FILE)) {
      fs.unlinkSync(TEST_CACHE_FILE);
    }
  });

  describe("getCachedSticker", () => {
    it("returns null for unknown ID", () => {
      const result = getCachedSticker("unknown-id");
      expect(result).toBeNull();
    });

    it("returns cached sticker after cacheSticker", () => {
      const sticker = {
        fileId: "file123",
        fileUniqueId: "unique123",
        emoji: "🎉",
        setName: "TestPack",
        description: "A party popper emoji sticker",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      cacheSticker(sticker);
      const result = getCachedSticker("unique123");

      expect(result).toEqual(sticker);
    });

    it("returns null after cache is cleared", () => {
      const sticker = {
        fileId: "file123",
        fileUniqueId: "unique123",
        description: "test",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      cacheSticker(sticker);
      expect(getCachedSticker("unique123")).not.toBeNull();

      // Manually clear the cache file
      fs.unlinkSync(TEST_CACHE_FILE);

      expect(getCachedSticker("unique123")).toBeNull();
    });
  });

  describe("cacheSticker", () => {
    it("adds entry to cache", () => {
      const sticker = {
        fileId: "file456",
        fileUniqueId: "unique456",
        description: "A cute fox waving",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      cacheSticker(sticker);

      const all = getAllCachedStickers();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(sticker);
    });

    it("updates existing entry", () => {
      const original = {
        fileId: "file789",
        fileUniqueId: "unique789",
        description: "Original description",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };
      const updated = {
        fileId: "file789-new",
        fileUniqueId: "unique789",
        description: "Updated description",
        cachedAt: "2026-01-26T13:00:00.000Z",
      };

      cacheSticker(original);
      cacheSticker(updated);

      const result = getCachedSticker("unique789");
      expect(result?.description).toBe("Updated description");
      expect(result?.fileId).toBe("file789-new");
    });
  });

  describe("searchStickers", () => {
    beforeEach(() => {
      // Seed cache with test stickers
      cacheSticker({
        fileId: "fox1",
        fileUniqueId: "fox-unique-1",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A cute orange fox waving hello",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      cacheSticker({
        fileId: "fox2",
        fileUniqueId: "fox-unique-2",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A fox sleeping peacefully",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });
      cacheSticker({
        fileId: "cat1",
        fileUniqueId: "cat-unique-1",
        emoji: "🐱",
        setName: "FunnyCats",
        description: "A cat sitting on a keyboard",
        cachedAt: "2026-01-26T12:00:00.000Z",
      });
      cacheSticker({
        fileId: "dog1",
        fileUniqueId: "dog-unique-1",
        emoji: "🐶",
        setName: "GoodBoys",
        description: "A golden retriever playing fetch",
        cachedAt: "2026-01-26T13:00:00.000Z",
      });
    });

    it("finds stickers by description substring", () => {
      const results = searchStickers("fox");
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.description.toLowerCase().includes("fox"))).toBe(true);
    });

    it("finds stickers by emoji", () => {
      const results = searchStickers("🦊");
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.emoji === "🦊")).toBe(true);
    });

    it("finds stickers by set name", () => {
      const results = searchStickers("CuteFoxes");
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.setName === "CuteFoxes")).toBe(true);
    });

    it("respects limit parameter", () => {
      const results = searchStickers("fox", 1);
      expect(results).toHaveLength(1);
    });

    it("ranks exact matches higher", () => {
      // "waving" appears in "fox waving hello" - should be ranked first
      const results = searchStickers("waving");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("fox-unique-1");
    });

    it("returns empty array for no matches", () => {
      const results = searchStickers("elephant");
      expect(results).toHaveLength(0);
    });

    it("is case insensitive", () => {
      const results = searchStickers("FOX");
      expect(results).toHaveLength(2);
    });

    it("matches multiple words", () => {
      const results = searchStickers("cat keyboard");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("cat-unique-1");
    });
  });

  describe("getAllCachedStickers", () => {
    it("returns empty array when cache is empty", () => {
      const result = getAllCachedStickers();
      expect(result).toEqual([]);
    });

    it("returns all cached stickers", () => {
      cacheSticker({
        fileId: "a",
        fileUniqueId: "a-unique",
        description: "Sticker A",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      cacheSticker({
        fileId: "b",
        fileUniqueId: "b-unique",
        description: "Sticker B",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });

      const result = getAllCachedStickers();
      expect(result).toHaveLength(2);
    });
  });

  describe("getCacheStats", () => {
    it("returns count 0 when cache is empty", () => {
      const stats = getCacheStats();
      expect(stats.count).toBe(0);
      expect(stats.oldestAt).toBeUndefined();
      expect(stats.newestAt).toBeUndefined();
    });

    it("returns correct stats with cached stickers", () => {
      cacheSticker({
        fileId: "old",
        fileUniqueId: "old-unique",
        description: "Old sticker",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });
      cacheSticker({
        fileId: "new",
        fileUniqueId: "new-unique",
        description: "New sticker",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      cacheSticker({
        fileId: "mid",
        fileUniqueId: "mid-unique",
        description: "Middle sticker",
        cachedAt: "2026-01-23T10:00:00.000Z",
      });

      const stats = getCacheStats();
      expect(stats.count).toBe(3);
      expect(stats.oldestAt).toBe("2026-01-20T10:00:00.000Z");
      expect(stats.newestAt).toBe("2026-01-26T10:00:00.000Z");
    });
  });
});
