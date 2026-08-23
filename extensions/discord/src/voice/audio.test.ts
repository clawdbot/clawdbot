// Discord tests cover audio plugin behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, voiceWorkspaceFixture } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  voiceWorkspaceFixture: {
    rootDir: "",
    writeError: undefined as Error | undefined,
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveFfmpegBin: () => "ffmpeg",
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => voiceWorkspaceFixture.rootDir,
    tempWorkspace: async (options: Parameters<typeof actual.tempWorkspace>[0]) => {
      const workspace = await actual.tempWorkspace({
        ...options,
        rootDir: voiceWorkspaceFixture.rootDir,
      });
      return {
        ...workspace,
        write: async (fileName: string, data: string | Uint8Array) => {
          if (voiceWorkspaceFixture.writeError) {
            await workspace.write(fileName, Buffer.from(data).subarray(0, 8));
            throw voiceWorkspaceFixture.writeError;
          }
          return await workspace.write(fileName, data);
        },
      };
    },
  };
});

import {
  createDiscordOpusEncodeStream,
  createDiscordOpusPlaybackStream,
  decodeOpusStream,
  decodeOpusStreamChunks,
  writeVoiceWavFile,
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

describe("Discord voice WAV workspace ownership", () => {
  async function withVoiceWorkspace(
    run: (params: { rootDir: string; timeoutSpy: ReturnType<typeof vi.spyOn> }) => Promise<void>,
  ): Promise<void> {
    const rootDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-voice-workspace-")),
    );
    voiceWorkspaceFixture.rootDir = rootDir;
    voiceWorkspaceFixture.writeError = undefined;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await run({ rootDir, timeoutSpy });
    } finally {
      for (const result of timeoutSpy.mock.results) {
        if (result.type === "return") {
          clearTimeout(result.value as ReturnType<typeof setTimeout>);
        }
      }
      timeoutSpy.mockRestore();
      voiceWorkspaceFixture.rootDir = "";
      voiceWorkspaceFixture.writeError = undefined;
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }

  it("owns partial WAV writes before surfacing their original failure", async () => {
    await withVoiceWorkspace(async ({ rootDir, timeoutSpy }) => {
      const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      voiceWorkspaceFixture.writeError = writeError;

      await expect(writeVoiceWavFile(Buffer.alloc(960))).rejects.toBe(writeError);

      const workspaces = await fs.readdir(rootDir);
      expect(workspaces).toHaveLength(1);
      expect(await fs.readFile(path.join(rootDir, workspaces[0]!, "segment.wav"))).toHaveLength(8);
      const scheduledCleanup = timeoutSpy.mock.calls.find(
        (call: Parameters<typeof setTimeout>) => call[1] === 30 * 60 * 1_000,
      );
      expect(scheduledCleanup).toBeDefined();

      (scheduledCleanup![0] as () => void)();

      await vi.waitFor(async () => expect(await fs.readdir(rootDir)).toEqual([]));
    });
  });

  it("retains successful WAV files until the existing scheduled cleanup runs", async () => {
    await withVoiceWorkspace(async ({ rootDir, timeoutSpy }) => {
      const pcm = Buffer.alloc(960);

      const result = await writeVoiceWavFile(pcm);

      expect(path.basename(result.path)).toBe("segment.wav");
      expect((await fs.readFile(result.path)).subarray(0, 4).toString()).toBe("RIFF");
      expect(result.durationSeconds).toBe(960 / (4 * 48_000));
      const scheduledCleanup = timeoutSpy.mock.calls.find(
        (call: Parameters<typeof setTimeout>) => call[1] === 30 * 60 * 1_000,
      );
      expect(scheduledCleanup).toBeDefined();
      expect(await fs.readdir(rootDir)).toHaveLength(1);

      (scheduledCleanup![0] as () => void)();

      await vi.waitFor(async () => expect(await fs.readdir(rootDir)).toEqual([]));
    });
  });
});
