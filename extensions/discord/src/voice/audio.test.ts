// Discord tests cover audio plugin behavior.
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveFfmpegBin: () => "ffmpeg",
}));

import {
  createDiscordOpusEncodeStream,
  createDiscordOpusPlaybackStream,
  decodeOpusStream,
  decodeOpusStreamChunks,
} from "./audio.js";

function createFakeFfmpeg() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

async function collectBuffers(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return chunks;
}

describe("discord voice opus codec", () => {
  it("defaults to libopus-wasm for receive decoding", async () => {
    const verbose: string[] = [];
    const warnings: string[] = [];

    const decoded = await decodeOpusStream(Readable.from([]), {
      onVerbose: (message) => verbose.push(message),
      onWarn: (message) => warnings.push(message),
    });

    expect(decoded.length).toBe(0);
    expect(verbose).toContain("opus decoder: libopus-wasm");
    expect(warnings).toEqual([]);
  });

  it("encodes raw Discord PCM into Opus packets for realtime playback", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc(960 * 2 * 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
    expect(packets[0]?.length).toBeGreaterThan(0);

    const decoded = await decodeOpusStream(Readable.from(packets), {
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });
    expect(decoded.length).toBe(960 * 2 * 2);
  });

  it("pads final partial PCM frames before encoding", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc((960 * 2 * 2) / 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
  });

  it("surfaces chunk decode stream failures to callers", async () => {
    const err = new Error("memory access out of bounds");
    const onError = vi.fn();
    const stream = new Readable({
      read() {
        this.destroy(err);
      },
    });

    await decodeOpusStreamChunks(stream, {
      onChunk: vi.fn(),
      onError,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith(err);
  });
});

describe("createDiscordOpusPlaybackStream child stream errors", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it.each(["stdout", "stderr"] as const)(
    "routes a %s stream error to the playback stream instead of crashing",
    async (streamName) => {
      const ffmpeg = createFakeFfmpeg();
      spawnMock.mockReturnValue(ffmpeg);

      const playback = createDiscordOpusPlaybackStream("input.mp3");
      const errorSeen = new Promise<Error>((resolve) => {
        playback.once("error", resolve);
      });

      const streamError = new Error(`${streamName} broke`);
      expect(() => ffmpeg[streamName].emit("error", streamError)).not.toThrow();

      await expect(errorSeen).resolves.toBe(streamError);
      expect(ffmpeg.kill).toHaveBeenCalledOnce();
      expect(ffmpeg.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("bounds multibyte ffmpeg stderr by bytes without a replacement character", async () => {
    const ffmpeg = createFakeFfmpeg();
    spawnMock.mockReturnValue(ffmpeg);

    const playback = createDiscordOpusPlaybackStream("input.mp3");
    const errorSeen = new Promise<Error>((resolve) => {
      playback.once("error", resolve);
    });

    ffmpeg.stderr.write("é".repeat(4095));
    ffmpeg.stderr.write("😀");
    ffmpeg.emit("close", 1, null);

    const error = await errorSeen;
    const stderrText = error.message.replace(/^ffmpeg exited with code 1: /, "");
    expect(stderrText).toBe("é".repeat(4095));
    expect(Buffer.byteLength(stderrText)).toBeLessThanOrEqual(8192);
    expect(stderrText).not.toContain("\uFFFD");
  });
});
