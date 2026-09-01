import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

let store: typeof import("./store.js");
let tempHome: TempHomeEnv;

type PlaybackCacheTestApi = {
  enforcePlaybackTranscodeCacheLimit(): Promise<void>;
  PLAYBACK_TRANSCODE_MAX_CACHE_BYTES: number;
  PLAYBACK_TRANSCODE_TTL_MS: number;
};

function getPlaybackCacheTestApi(): PlaybackCacheTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaStoreTestApi")
  ];
  if (!api) {
    throw new Error("media store test API is unavailable");
  }
  return api as PlaybackCacheTestApi;
}

beforeAll(async () => {
  tempHome = await createTempHomeEnv("openclaw-playback-cache-");
  store = await import("./store.js");
});

afterAll(async () => {
  await tempHome.restore();
});

afterEach(async () => {
  await fs.rm(store.getMediaDir(), { recursive: true, force: true });
});

it("evicts oldest playback transcodes when insertion enforcement exceeds its byte budget", async () => {
  const testApi = getPlaybackCacheTestApi();
  const mediaDir = await store.ensureMediaDir();
  const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
  await fs.mkdir(cacheDir, { recursive: true });
  const oldPath = path.join(cacheDir, "v2-old.mp4");
  const newPath = path.join(cacheDir, "v2-new.mp4");
  const sparseSize = Math.floor(testApi.PLAYBACK_TRANSCODE_MAX_CACHE_BYTES * 0.6);
  await Promise.all([fs.writeFile(oldPath, ""), fs.writeFile(newPath, "")]);
  await Promise.all([fs.truncate(oldPath, sparseSize), fs.truncate(newPath, sparseSize)]);
  const nowMs = Date.now();
  await fs.utimes(oldPath, (nowMs - 2_000) / 1000, (nowMs - 2_000) / 1000);
  await fs.utimes(newPath, (nowMs - 1_000) / 1000, (nowMs - 1_000) / 1000);

  await testApi.enforcePlaybackTranscodeCacheLimit();

  await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(newPath)).resolves.toMatchObject({ size: sparseSize });
});

it("prunes only playback entries using the fixed seven-day retention", async () => {
  const testApi = getPlaybackCacheTestApi();
  const mediaDir = await store.ensureMediaDir();
  const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
  await fs.mkdir(cacheDir, { recursive: true });
  const freshPath = path.join(cacheDir, "v2-fresh.m4a");
  const oldPath = path.join(cacheDir, "v2-expired.m4a");
  const transientPath = path.join(mediaDir, "expired-transient.m4a");
  await Promise.all([
    fs.writeFile(freshPath, "fresh"),
    fs.writeFile(oldPath, "old"),
    fs.writeFile(transientPath, "transient"),
  ]);
  const nowMs = Date.now();
  await fs.utimes(freshPath, (nowMs - 5 * 60_000) / 1000, (nowMs - 5 * 60_000) / 1000);
  const expiredMs = nowMs - testApi.PLAYBACK_TRANSCODE_TTL_MS - 1_000;
  await Promise.all([
    fs.utimes(oldPath, expiredMs / 1000, expiredMs / 1000),
    fs.utimes(transientPath, expiredMs / 1000, expiredMs / 1000),
  ]);

  await store.prunePlaybackTranscodeCache();

  await expect(fs.stat(freshPath)).resolves.toMatchObject({ size: 5 });
  await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(transientPath)).resolves.toMatchObject({ size: 9 });
});
