import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

let store: typeof import("./store.js");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  tempHome = await createTempHomeEnv("openclaw-playback-cache-");
  store = await import("./store.js");
});

afterAll(async () => {
  await tempHome.restore();
});

it("evicts oldest playback transcodes when insertion enforcement exceeds its byte budget", async () => {
  const mediaDir = await store.ensureMediaDir();
  const cacheDir = path.join(mediaDir, store.PLAYBACK_TRANSCODE_SUBDIR);
  await fs.mkdir(cacheDir, { recursive: true });
  const oldPath = path.join(cacheDir, "v2-old.mp4");
  const newPath = path.join(cacheDir, "v2-new.mp4");
  const sparseSize = Math.floor(store.PLAYBACK_TRANSCODE_MAX_CACHE_BYTES * 0.6);
  await Promise.all([fs.writeFile(oldPath, ""), fs.writeFile(newPath, "")]);
  await Promise.all([fs.truncate(oldPath, sparseSize), fs.truncate(newPath, sparseSize)]);
  const nowMs = Date.now();
  await fs.utimes(oldPath, (nowMs - 2_000) / 1000, (nowMs - 2_000) / 1000);
  await fs.utimes(newPath, (nowMs - 1_000) / 1000, (nowMs - 1_000) / 1000);

  await store.enforcePlaybackTranscodeCacheLimit();

  await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(newPath)).resolves.toMatchObject({ size: sparseSize });
});
