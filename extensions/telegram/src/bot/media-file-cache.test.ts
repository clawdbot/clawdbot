import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The cache is module-global; reset modules so each test gets a fresh map.
let cacheModule: typeof import("./media-file-cache.js");

beforeEach(async () => {
  vi.resetModules();
  cacheModule = await import("./media-file-cache.js");
});

afterEach(() => {
  vi.useRealTimers();
});

const ENTRY = { path: "/media/inbound/photo.jpg", kind: "image", size: 1024 } as const;

describe("telegram media file cache", () => {
  it("returns the cached entry while it is fresh and within the caller limit", () => {
    cacheModule.cacheTelegramMediaFile("unique-1", { ...ENTRY, contentType: "image/png" });

    expect(cacheModule.getCachedTelegramMediaFile("unique-1", 2048)).toEqual({
      ...ENTRY,
      contentType: "image/png",
      expiresAt: expect.any(Number),
    });
  });

  it("misses for unknown files", () => {
    expect(cacheModule.getCachedTelegramMediaFile("never-cached", 2048)).toBeNull();
  });

  it("refuses reuse when the caller enforces a smaller limit but keeps the entry", () => {
    cacheModule.cacheTelegramMediaFile("unique-1", ENTRY);

    // A second account with a smaller mediaMaxMb must not reuse the file.
    expect(cacheModule.getCachedTelegramMediaFile("unique-1", 512)).toBeNull();
    // The original larger-limit caller can still hit the same entry.
    expect(cacheModule.getCachedTelegramMediaFile("unique-1", 2048)).not.toBeNull();
  });

  it("expires entries without touching the filesystem", () => {
    vi.useFakeTimers();
    cacheModule.cacheTelegramMediaFile("unique-1", ENTRY);

    vi.advanceTimersByTime(56 * 60_000);

    expect(cacheModule.getCachedTelegramMediaFile("unique-1", 2048)).toBeNull();
  });

  it("evicts the oldest entries beyond the bound", () => {
    cacheModule.cacheTelegramMediaFile("unique-first", ENTRY);
    for (let index = 0; index < 500; index += 1) {
      cacheModule.cacheTelegramMediaFile(`unique-${index}`, ENTRY);
    }

    expect(cacheModule.getCachedTelegramMediaFile("unique-first", 2048)).toBeNull();
    expect(cacheModule.getCachedTelegramMediaFile("unique-499", 2048)).not.toBeNull();
  });
});
