// TTS media-store tests cover stable paths, Control UI roots, and TTL cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { cleanOldMedia } from "../media/store.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { persistTtsAudioToMediaStore } from "./tts-audio-store.js";

describe("TTS audio media store", () => {
  it("saves allowlisted speech output and prunes it through media maintenance", async () => {
    const tempHome = await createTempHomeEnv("openclaw-tts-media-store-");
    try {
      const audioBuffer = Buffer.from("OggS test voice");
      const audioPath = await persistTtsAudioToMediaStore({
        audioBuffer,
        cfg: {},
        fileExtension: ".ogg",
        outputFormat: "ogg",
      });

      expect(path.dirname(audioPath)).toBe(
        path.join(tempHome.home, ".openclaw", "media", "tool-speech-synthesis"),
      );
      expect(path.basename(audioPath)).toMatch(/^voice---[a-f0-9-]+\.ogg$/);
      await expect(fs.readFile(audioPath)).resolves.toEqual(audioBuffer);

      const localRoots = getAgentScopedMediaLocalRoots({});
      expect(localRoots).toContain(path.join(tempHome.home, ".openclaw", "media"));

      const expired = Date.now() - 10_000;
      await fs.utimes(audioPath, expired / 1000, expired / 1000);
      await cleanOldMedia(1, { recursive: true });
      await expect(fs.stat(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await tempHome.restore();
    }
  });
});
