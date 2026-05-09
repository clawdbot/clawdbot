import { beforeEach, describe, expect, it, vi } from "vitest";
import * as stickerCache from "./sticker-cache-store.js";

const jsonStoreMocks = vi.hoisted(() => {
  const store: { value: unknown } = { value: null };
  return {
    store,
    loadJsonFile: vi.fn(() => store.value),
    saveJsonFile: vi.fn((_file: string, value: unknown) => {
      store.value = structuredClone(value);
    }),
  };
});

vi.mock("openclaw/plugin-sdk/json-store", () => ({
  loadJsonFile: jsonStoreMocks.loadJsonFile,
  saveJsonFile: jsonStoreMocks.saveJsonFile,
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-test-sticker-cache",
}));

describe("sticker-cache", () => {
  beforeEach(() => {
    jsonStoreMocks.store.value = null;
    jsonStoreMocks.loadJsonFile.mockClear();
    jsonStoreMocks.saveJsonFile.mockClear();
  });

  describe("getCachedSticker", () => {
    it("returns null for unknown ID", () => {
      const result = stickerCache.getCachedSticker("unknown-id");
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

      stickerCache.cacheSticker(sticker);
      const result = stickerCache.getCachedSticker("unique123");

      expect(result).toEqual(sticker);
    });

    it("returns null after backing store is cleared", () => {
      const sticker = {
        fileId: "file123",
        fileUniqueId: "unique123",
        description: "test",
        cachedAt: "2026-01-26T12:00:00.000Z",
      };

      stickerCache.cacheSticker(sticker);
      const cachedSticker = stickerCache.getCachedSticker("unique123");
      if (!cachedSticker) {
        throw new Error("expected cached Telegram sticker");
      }
      expect(cachedSticker.fileUniqueId).toBe("unique123");

      jsonStoreMocks.store.value = null;

      expect(stickerCache.getCachedSticker("unique123")).toBeNull();
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

      stickerCache.cacheSticker(sticker);

      const all = stickerCache.getAllCachedStickers();
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

      stickerCache.cacheSticker(original);
      stickerCache.cacheSticker(updated);

      const result = stickerCache.getCachedSticker("unique789");
      expect(result?.description).toBe("Updated description");
      expect(result?.fileId).toBe("file789-new");
    });
  });

  describe("searchStickers", () => {
    beforeEach(() => {
      // Seed cache with test stickers
      stickerCache.cacheSticker({
        fileId: "fox1",
        fileUniqueId: "fox-unique-1",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A cute orange fox waving hello",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "fox2",
        fileUniqueId: "fox-unique-2",
        emoji: "🦊",
        setName: "CuteFoxes",
        description: "A fox sleeping peacefully",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "cat1",
        fileUniqueId: "cat-unique-1",
        emoji: "🐱",
        setName: "FunnyCats",
        description: "A cat sitting on a keyboard",
        cachedAt: "2026-01-26T12:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "dog1",
        fileUniqueId: "dog-unique-1",
        emoji: "🐶",
        setName: "GoodBoys",
        description: "A golden retriever playing fetch",
        cachedAt: "2026-01-26T13:00:00.000Z",
      });
    });

    it("finds stickers by description substring", () => {
      const results = stickerCache.searchStickers("fox");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("finds stickers by emoji", () => {
      const results = stickerCache.searchStickers("🦊");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("finds stickers by set name", () => {
      const results = stickerCache.searchStickers("CuteFoxes");
      expect(results).toHaveLength(2);
      expect(results.map((sticker) => sticker.fileUniqueId)).toEqual([
        "fox-unique-1",
        "fox-unique-2",
      ]);
    });

    it("respects limit parameter", () => {
      const results = stickerCache.searchStickers("fox", 1);
      expect(results).toHaveLength(1);
    });

    it("ranks exact matches higher", () => {
      // "waving" appears in "fox waving hello" - should be ranked first
      const results = stickerCache.searchStickers("waving");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("fox-unique-1");
    });

    it("returns empty array for no matches", () => {
      const results = stickerCache.searchStickers("elephant");
      expect(results).toHaveLength(0);
    });

    it("is case insensitive", () => {
      const results = stickerCache.searchStickers("FOX");
      expect(results).toHaveLength(2);
    });

    it("matches multiple words", () => {
      const results = stickerCache.searchStickers("cat keyboard");
      expect(results).toHaveLength(1);
      expect(results[0]?.fileUniqueId).toBe("cat-unique-1");
    });
  });

  describe("getAllCachedStickers", () => {
    it("returns empty array when cache is empty", () => {
      const result = stickerCache.getAllCachedStickers();
      expect(result).toStrictEqual([]);
    });

    it("returns all cached stickers", () => {
      stickerCache.cacheSticker({
        fileId: "a",
        fileUniqueId: "a-unique",
        description: "Sticker A",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "b",
        fileUniqueId: "b-unique",
        description: "Sticker B",
        cachedAt: "2026-01-26T11:00:00.000Z",
      });

      const result = stickerCache.getAllCachedStickers();
      expect(result).toHaveLength(2);
    });
  });

  describe("getCacheStats", () => {
    it("returns count 0 when cache is empty", () => {
      const stats = stickerCache.getCacheStats();
      expect(stats.count).toBe(0);
      expect(stats.oldestAt).toBeUndefined();
      expect(stats.newestAt).toBeUndefined();
    });

    it("returns correct stats with cached stickers", () => {
      stickerCache.cacheSticker({
        fileId: "old",
        fileUniqueId: "old-unique",
        description: "Old sticker",
        cachedAt: "2026-01-20T10:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "new",
        fileUniqueId: "new-unique",
        description: "New sticker",
        cachedAt: "2026-01-26T10:00:00.000Z",
      });
      stickerCache.cacheSticker({
        fileId: "mid",
        fileUniqueId: "mid-unique",
        description: "Middle sticker",
        cachedAt: "2026-01-23T10:00:00.000Z",
      });

      const stats = stickerCache.getCacheStats();
      expect(stats.count).toBe(3);
      expect(stats.oldestAt).toBe("2026-01-20T10:00:00.000Z");
      expect(stats.newestAt).toBe("2026-01-26T10:00:00.000Z");
    });
  });
});
