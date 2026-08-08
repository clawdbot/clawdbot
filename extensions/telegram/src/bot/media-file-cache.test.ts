import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The cache is module-global; reset modules so each test gets a fresh map.
let cacheModule: typeof import("./media-file-cache.js");

beforeEach(async () => {
  vi.resetModules();
  cacheModule = await import("./media-file-cache.js");
});

function writeTempMediaFile(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  return filePath;
}

describe("telegram media file cache", () => {
  it("returns the cached entry while the local file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    const filePath = writeTempMediaFile(dir, "photo.jpg");
    cacheModule.cacheTelegramMediaFile("unique-1", {
      path: filePath,
      kind: "image",
      contentType: "image/png",
    });

    expect(cacheModule.getCachedTelegramMediaFile("unique-1")).toEqual({
      path: filePath,
      kind: "image",
      contentType: "image/png",
    });
  });

  it("evicts the entry and misses when the local file was pruned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    const filePath = writeTempMediaFile(dir, "photo.jpg");
    cacheModule.cacheTelegramMediaFile("unique-1", { path: filePath, kind: "image" });

    fs.rmSync(filePath);

    expect(cacheModule.getCachedTelegramMediaFile("unique-1")).toBeNull();
    // The stale entry was dropped, so a later re-download can re-cache cleanly.
    expect(cacheModule.getCachedTelegramMediaFile("unique-1")).toBeNull();
  });

  it("misses for unknown files", () => {
    expect(cacheModule.getCachedTelegramMediaFile("never-cached")).toBeNull();
  });

  it("evicts the oldest entries beyond the bound", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    const firstPath = writeTempMediaFile(dir, "first.jpg");
    cacheModule.cacheTelegramMediaFile("unique-first", { path: firstPath, kind: "image" });
    for (let index = 0; index < 500; index += 1) {
      cacheModule.cacheTelegramMediaFile(`unique-${index}`, {
        path: writeTempMediaFile(dir, `photo-${index}.jpg`),
        kind: "image",
      });
    }

    expect(cacheModule.getCachedTelegramMediaFile("unique-first")).toBeNull();
    expect(cacheModule.getCachedTelegramMediaFile("unique-499")).not.toBeNull();
  });
});
