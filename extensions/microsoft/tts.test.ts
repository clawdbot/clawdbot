import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

let edgeTTS: typeof import("./tts.js").edgeTTS;

function createEdgeTTSDeps(ttsPromise: (text: string, filePath: string) => Promise<void>) {
  return {
    EdgeTTS: class {
      ttsPromise(text: string, filePath: string) {
        return ttsPromise(text, filePath);
      }
    },
  };
}

const baseEdgeConfig = {
  voice: "en-US-MichelleNeural",
  lang: "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  saveSubtitles: false,
};

describe("edgeTTS empty audio validation", () => {
  let tempDir: string | undefined;

  beforeAll(async () => {
    ({ edgeTTS } = await import("./tts.js"));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("throws when the output file is 0 bytes", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");

    const deps = createEdgeTTSDeps(async (_text: string, filePath: string) => {
      writeFileSync(filePath, "");
    });

    await expect(
      edgeTTS(
        {
          text: "Hello",
          outputPath,
          config: baseEdgeConfig,
          timeoutMs: 10000,
        },
        deps,
      ),
    ).rejects.toThrow("Edge TTS produced empty audio file");
  });

  it("succeeds when the output file has content", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");

    const deps = createEdgeTTSDeps(async (_text: string, filePath: string) => {
      writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await expect(
      edgeTTS(
        {
          text: "Hello",
          outputPath,
          config: baseEdgeConfig,
          timeoutMs: 10000,
        },
        deps,
      ),
    ).resolves.toBeUndefined();
  });
});
