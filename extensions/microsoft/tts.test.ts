import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let edgeTTS: typeof import("./tts.js").edgeTTS;

function createEdgeTTSDeps(
  ttsPromise: (text: string, filePath: string) => Promise<void>,
  onConstruct?: () => void,
) {
  return {
    EdgeTTS: class {
      constructor() {
        onConstruct?.();
      }

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

  it("rejects blank text before constructing Edge TTS", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    const onConstruct = vi.fn();
    const deps = createEdgeTTSDeps(async (_text: string, filePath: string) => {
      writeFileSync(filePath, Buffer.from([0xff]));
    }, onConstruct);

    await expect(
      edgeTTS(
        {
          text: " \n\t ",
          outputPath,
          config: baseEdgeConfig,
          timeoutMs: 10000,
        },
        deps,
      ),
    ).rejects.toThrow("Microsoft TTS text cannot be empty");
    expect(onConstruct).not.toHaveBeenCalled();
  });

  it("throws after one retry when the output file stays empty", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    const calls: string[] = [];

    const deps = createEdgeTTSDeps(async (text: string, filePath: string) => {
      calls.push(text);
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
    ).rejects.toThrow("Edge TTS produced empty audio file after retry");
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("succeeds when the output file has content", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    let stagedPath = "";

    const deps = createEdgeTTSDeps(async (_text: string, filePath: string) => {
      stagedPath = filePath;
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
    expect(stagedPath).not.toBe(outputPath);
    expect(path.basename(stagedPath)).toContain(path.basename(outputPath));
    expect(path.basename(stagedPath)).toMatch(/\.part$/);
    expect(readFileSync(outputPath)).toEqual(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    expect(existsSync(stagedPath)).toBe(false);
  });

  it("retries once when the first output file is empty", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    const calls: string[] = [];

    const deps = createEdgeTTSDeps(async (text: string, filePath: string) => {
      calls.push(text);
      writeFileSync(filePath, calls.length === 1 ? "" : Buffer.from([0xff, 0xfb, 0x90, 0x00]));
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
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("retries once when Edge TTS resolves without creating an output file", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    const calls: string[] = [];

    const deps = createEdgeTTSDeps(async (text: string, filePath: string) => {
      calls.push(text);
      if (calls.length === 2) {
        writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      }
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
    expect(calls).toEqual(["Hello", "Hello"]);
  });

  it("does not retry provider errors", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "tts-test-"));
    const outputPath = path.join(tempDir, "voice.mp3");
    const calls: string[] = [];

    const deps = createEdgeTTSDeps(async (text: string) => {
      calls.push(text);
      throw new Error("upstream timeout");
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
    ).rejects.toThrow("upstream timeout");
    expect(calls).toEqual(["Hello"]);
  });
});
