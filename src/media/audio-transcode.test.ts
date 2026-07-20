// Audio transcode tests cover ffmpeg-backed audio conversion behavior.
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const runFfmpegMock = vi.hoisted(() => vi.fn());

vi.mock("./ffmpeg-exec.js", () => ({
  runFfmpeg: runFfmpegMock,
}));

import { transcodeAudioBuffer, transcodeAudioBufferToOpus } from "./audio-transcode.js";

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("transcodeAudioBufferToOpus", () => {
  afterEach(() => {
    runFfmpegMock.mockReset();
  });

  it("writes input audio, runs ffmpeg for 48k mono Opus, and cleans temp files", async () => {
    let capturedInputPath: string | undefined;
    let capturedOutputPath: string | undefined;
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      capturedInputPath = args[args.indexOf("-i") + 1];
      capturedOutputPath = args.at(-1);
      const inputPath = capturedInputPath;
      const outputPath = capturedOutputPath;
      if (!inputPath || !outputPath) {
        throw new Error("missing ffmpeg paths");
      }
      await expect(readFile(inputPath)).resolves.toEqual(Buffer.from("source-mp3"));
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(outputPath, Buffer.from("opus-output")),
      );
    });

    await expect(
      transcodeAudioBufferToOpus({
        audioBuffer: Buffer.from("source-mp3"),
        inputExtension: "mp3",
        tempPrefix: "tts-test-",
        timeoutMs: 1234,
      }),
    ).resolves.toEqual(Buffer.from("opus-output"));

    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    expect(firstMockCall(runFfmpegMock, "runFfmpeg")).toStrictEqual([
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        capturedInputPath,
        "-vn",
        "-sn",
        "-dn",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "opus",
        capturedOutputPath,
      ],
      { timeoutMs: 1234 },
    ]);
    const tempRoot = realpathSync(resolvePreferredOpenClawTmpDir());
    expect(capturedInputPath?.startsWith(path.join(tempRoot, "tts-test-"))).toBe(true);
    expect(capturedInputPath ? existsSync(capturedInputPath) : true).toBe(false);
    expect(capturedOutputPath ? existsSync(capturedOutputPath) : true).toBe(false);
  });

  it("sanitizes unsafe input extensions", async () => {
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      const inputPath = args[args.indexOf("-i") + 1];
      const outputPath = args.at(-1);
      if (!inputPath || !outputPath) {
        throw new Error("missing ffmpeg paths");
      }
      expect(path.basename(inputPath)).toBe("input.audio");
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(outputPath, Buffer.from("opus-output")),
      );
    });

    await transcodeAudioBufferToOpus({
      audioBuffer: Buffer.from("source"),
      inputExtension: "../bad",
    });
  });

  it("passes the maximum duration to ffmpeg when requested", async () => {
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      const outputPath = args.at(-1);
      if (!outputPath) {
        throw new Error("missing ffmpeg output path");
      }
      await writeFile(outputPath, Buffer.from("ogg-opus-output"));
    });

    await transcodeAudioBufferToOpus({
      audioBuffer: Buffer.from("source-m4a"),
      maxDurationSeconds: 300,
    });

    const ffmpegArgs = firstMockCall(runFfmpegMock, "runFfmpeg")[0] as string[];
    expect(ffmpegArgs).toEqual(expect.arrayContaining(["-t", "300", "-c:a", "libopus"]));
  });

  it("keeps temp prefixes and output names inside the preferred temp root", async () => {
    let capturedInputPath: string | undefined;
    let capturedOutputPath: string | undefined;
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      capturedInputPath = args[args.indexOf("-i") + 1];
      capturedOutputPath = args.at(-1);
      const outputPath = capturedOutputPath;
      if (!outputPath) {
        throw new Error("missing ffmpeg output path");
      }
      const outputBaseName = path.basename(outputPath);
      expect(outputBaseName).toContain("escape.opus");
      expect(outputBaseName).toMatch(/\.part$/);
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(outputPath, Buffer.from("opus-output")),
      );
    });

    await transcodeAudioBufferToOpus({
      audioBuffer: Buffer.from("source"),
      inputFileName: "voice.wav",
      outputFileName: "../escape.opus",
      tempPrefix: "../bad-prefix",
    });

    const tempRoot = realpathSync(resolvePreferredOpenClawTmpDir());
    expect(capturedInputPath?.startsWith(tempRoot)).toBe(true);
    expect(capturedOutputPath ? existsSync(capturedOutputPath) : true).toBe(false);
  });

  it("preserves Windows-style output filename leaves on POSIX hosts", async () => {
    let capturedOutputPath: string | undefined;
    runFfmpegMock.mockImplementationOnce(async (args: string[]) => {
      capturedOutputPath = args.at(-1);
      const outputPath = capturedOutputPath;
      if (!outputPath) {
        throw new Error("missing ffmpeg output path");
      }
      expect(path.basename(outputPath)).toContain("reply.opus");
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(outputPath, Buffer.from("opus-output")),
      );
    });

    await transcodeAudioBufferToOpus({
      audioBuffer: Buffer.from("source"),
      outputFileName: String.raw`C:\Users\Ada\Downloads\reply.opus`,
    });

    expect(capturedOutputPath ? existsSync(capturedOutputPath) : true).toBe(false);
  });
});

describe("transcodeAudioBuffer", () => {
  afterEach(() => {
    runFfmpegMock.mockReset();
  });

  it("returns noop-same-container when source and target containers match", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: ".mp3",
    });
    expect(result).toEqual({ ok: false, reason: "noop-same-container" });
  });

  it("returns no-recipe when no afconvert recipe is defined for the requested pair", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "flac",
    });
    expect(result).toEqual({ ok: false, reason: "no-recipe" });
  });

  it("returns invalid-extension for an empty source extension", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("returns invalid-extension for an empty target extension", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("rejects path-traversal style extensions", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "../etc/passwd",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("returns platform-unsupported off-Darwin without invoking afconvert", async () => {
    if (process.platform === "darwin") {
      return;
    }
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "platform-unsupported" });
  });
});
