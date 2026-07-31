// Senseaudio live tests cover the real speech generation and provider API.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { senseaudioMediaUnderstandingProvider } from "./media-understanding-provider.js";

const apiKey = process.env.SENSEAUDIO_API_KEY ?? "";
const liveEnabled = process.env.OPENCLAW_LIVE_TEST === "1" && apiKey.length > 0;
const hasSay =
  liveEnabled &&
  spawnSync("sh", ["-lc", "command -v say"], { encoding: "utf8", timeout: 5_000 }).status === 0;
const describeLive = liveEnabled && hasSay ? describe : describe.skip;
const transcribeSenseAudioAudio = senseaudioMediaUnderstandingProvider.transcribeAudio;

if (!transcribeSenseAudioAudio) {
  throw new Error("expected SenseAudio transcription capability");
}

describeLive("SenseAudio live", () => {
  it("transcribes generated speech", async () => {
    await withTempDir("openclaw-senseaudio-live-", async (tempDir) => {
      const aiffPath = path.join(tempDir, "speech.aiff");
      const mp3Path = path.join(tempDir, "speech.mp3");
      const sayResult = spawnSync("say", ["-o", aiffPath, "open claw live transcription test"], {
        encoding: "utf8",
      });
      expect(sayResult.status).toBe(0);
      await runFfmpeg(["-y", "-i", aiffPath, "-c:a", "libmp3lame", "-b:a", "96k", mp3Path]);

      const result = await transcribeSenseAudioAudio({
        buffer: readFileSync(mp3Path),
        fileName: "speech.mp3",
        mime: "audio/mpeg",
        apiKey,
        timeoutMs: 30_000,
      });

      expect(result.text.trim().length).toBeGreaterThan(0);
    });
  }, 60_000);
});
