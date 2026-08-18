// Tts Local Cli live tests cover the real process and ffmpeg integration.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveFfmpegBin, runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import type { SpeechProviderConfig } from "openclaw/plugin-sdk/speech-core";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildCliSpeechProvider } from "./speech-provider.js";

const describeLive = process.env.OPENCLAW_LIVE_TEST === "1" ? describe : describe.skip;

function firstOggPacketPrefix(buffer: Buffer, length: number): string {
  const segmentCount = buffer[26] ?? 0;
  return buffer.subarray(27 + segmentCount, 27 + segmentCount + length).toString("ascii");
}

describeLive("buildCliSpeechProvider live", () => {
  it("synthesizes through a real local CLI fixture and ffmpeg", async () => {
    await withTempDir("openclaw-cli-tts-live-", async (dir) => {
      const script = path.join(dir, "copy-audio.mjs");
      const wavPath = path.join(dir, "source.wav");
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=0.1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ]);
      writeFileSync(
        script,
        `
import { copyFileSync } from "node:fs";
const outIndex = process.argv.indexOf("--out");
copyFileSync(${JSON.stringify(wavPath)}, process.argv[outIndex + 1]);
`,
      );
      const providerConfig: SpeechProviderConfig = {
        command: process.execPath,
        args: [script, "--out", "{{OutputPath}}"],
        outputFormat: "wav",
        timeoutMs: 30_000,
      };

      const result = await buildCliSpeechProvider().synthesize({
        text: "hello world",
        cfg: {} as OpenClawConfig,
        providerConfig,
        providerOverrides: {},
        timeoutMs: 30_000,
        target: "voice-note",
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".ogg");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.byteLength).toBeGreaterThan(0);
      expect(readFileSync(wavPath).byteLength).toBeGreaterThan(0);
    });
  }, 30_000);

  it("detects MP3 stdout and converts it to configured WAV", async () => {
    const providerConfig: SpeechProviderConfig = {
      command: resolveFfmpegBin(),
      args: [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=0.1",
        "-c:a",
        "libmp3lame",
        "-f",
        "mp3",
        "pipe:1",
      ],
      outputFormat: "wav",
      timeoutMs: 30_000,
    };

    const result = await buildCliSpeechProvider().synthesize({
      text: "hello world",
      cfg: {} as OpenClawConfig,
      providerConfig,
      providerOverrides: {},
      timeoutMs: 30_000,
      target: "audio-file",
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
  }, 30_000);

  it("detects Ogg Vorbis stdout and converts it to Ogg Opus for voice notes", async () => {
    const providerConfig: SpeechProviderConfig = {
      command: resolveFfmpegBin(),
      args: [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=660:duration=0.1",
        "-ac",
        "2",
        "-c:a",
        "vorbis",
        "-strict",
        "-2",
        "-f",
        "ogg",
        "pipe:1",
      ],
      outputFormat: "opus",
      timeoutMs: 30_000,
    };

    const result = await buildCliSpeechProvider().synthesize({
      text: "hello world",
      cfg: {} as OpenClawConfig,
      providerConfig,
      providerOverrides: {},
      timeoutMs: 30_000,
      target: "voice-note",
    });

    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".ogg");
    expect(result.voiceCompatible).toBe(true);
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("OggS");
    expect(firstOggPacketPrefix(result.audioBuffer, 8)).toBe("OpusHead");
  }, 30_000);
});
