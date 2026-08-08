import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheTelegramMediaFile,
  clearTelegramMediaFileCache,
  getCachedTelegramMediaFile,
} from "./media-file-cache.js";

afterEach(() => {
  clearTelegramMediaFileCache();
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
    cacheTelegramMediaFile("unique-1", {
      path: filePath,
      kind: "photo",
      contentType: "image/png",
    });

    expect(getCachedTelegramMediaFile("unique-1")).toEqual({
      path: filePath,
      kind: "photo",
      contentType: "image/png",
    });
  });

  it("evicts the entry and misses when the local file was pruned", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    const filePath = writeTempMediaFile(dir, "photo.jpg");
    cacheTelegramMediaFile("unique-1", { path: filePath, kind: "photo" });

    fs.rmSync(filePath);

    expect(getCachedTelegramMediaFile("unique-1")).toBeNull();
    // The stale entry was dropped, so a later re-download can re-cache cleanly.
    expect(getCachedTelegramMediaFile("unique-1")).toBeNull();
  });

  it("misses for unknown files", () => {
    expect(getCachedTelegramMediaFile("never-cached")).toBeNull();
  });

  it("evicts the oldest entries beyond the bound", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    const firstPath = writeTempMediaFile(dir, "first.jpg");
    cacheTelegramMediaFile("unique-first", { path: firstPath, kind: "photo" });
    for (let index = 0; index < 500; index += 1) {
      cacheTelegramMediaFile(`unique-${index}`, {
        path: writeTempMediaFile(dir, `photo-${index}.jpg`),
        kind: "photo",
      });
    }

    expect(getCachedTelegramMediaFile("unique-first")).toBeNull();
    expect(getCachedTelegramMediaFile("unique-499")).not.toBeNull();
  });

  it("clear drops every entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-media-cache-"));
    cacheTelegramMediaFile("unique-1", {
      path: writeTempMediaFile(dir, "photo.jpg"),
      kind: "photo",
    });

    clearTelegramMediaFileCache();

    expect(getCachedTelegramMediaFile("unique-1")).toBeNull();
  });
});
