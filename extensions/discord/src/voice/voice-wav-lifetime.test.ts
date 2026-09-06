import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const workspace = vi.hoisted(() => ({
  rootDir: "",
  afterWrite: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: () => workspace.rootDir,
    // The receive owner must observe leave before its awaited WAV write returns.
    tempWorkspace: async (options: Parameters<typeof actual.tempWorkspace>[0]) => {
      const temporary = await actual.tempWorkspace(options);
      return {
        ...temporary,
        write: async (...args: Parameters<typeof temporary.write>) => {
          const filePath = await temporary.write(...args);
          await workspace.afterWrite?.();
          return filePath;
        },
      };
    },
  };
});

defineDiscordVoiceTests(
  ({
    expect,
    it,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    getSessionConnection,
    handleSpeakingStart,
    startTranscripts,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    loggerWarnMock,
  }) => {
    beforeEach(async () => {
      workspace.afterWrite = undefined;
      workspace.rootDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-wav-lifetime-")),
      );
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await fs.rm(workspace.rootDir, { recursive: true, force: true });
    });

    async function fixture(recording = true) {
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:guest"] }),
        createClientWithMember("guest", "Guest", "1234"),
      );
      const sink = vi.fn();
      if (recording) {
        await startTranscripts(manager, sink, "notes");
      } else {
        await manager.join({ guildId: "g1", channelId: "1001" });
      }
      decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
        for await (const pcm of input) {
          await callbacks.onChunk(pcm, pcm);
        }
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
        return { text: "Meeting notes" };
      });
      const entry = getSessionEntry(manager);
      const audio = await import("./audio.js");
      const writeWav = audio.writeVoiceWavFile;
      const cleanups: Promise<void>[] = [];
      vi.spyOn(audio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
        const wav = await writeWav(pcm);
        const released = createDeferred<void>();
        cleanups.push(released.promise);
        return {
          ...wav,
          cleanup: async () => {
            await wav.cleanup();
            released.resolve();
          },
        };
      });
      const receive = async (pcm = Buffer.alloc(192_000)) => {
        const stream = new PassThrough({ objectMode: true });
        getSessionConnection(entry).receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = handleSpeakingStart(manager, entry, "guest");
        stream.end(pcm);
        await receiving;
      };
      return { manager, entry, sink, receive, released: () => Promise.all(cleanups) };
    }

    it.each(["queued", "transcribing"] as const)(
      "retains %s WAV input beyond thirty minutes and releases it after transcription",
      async (phase) => {
        const f = await fixture();
        const blocked = createDeferred<void>();
        const transcribing = createDeferred<void>();
        if (phase === "queued") {
          f.entry.processingQueue = blocked.promise;
        } else {
          transcribeAudioFileMock.mockImplementationOnce(async ({ filePath }) => {
            transcribing.resolve();
            await blocked.promise;
            const wav = await fs.readFile(filePath);
            expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
            return { text: "Meeting notes" };
          });
        }
        const removals = vi.spyOn(fs, "rm");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          await f.receive();
          if (phase === "transcribing") {
            await transcribing.promise;
          }
          await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
          await Promise.all(removals.mock.results.map((result) => result.value));
          expect(await fs.readdir(workspace.rootDir)).toHaveLength(1);
          blocked.resolve();
          await f.entry.processingQueue;
          await f.released();
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: "Meeting notes" }),
          );
          expect(await fs.readdir(workspace.rootDir)).toEqual([]);
        } finally {
          blocked.resolve();
          await f.entry.processingQueue;
          await f.released();
          await f.manager.destroy();
        }
      },
    );

    it.each([
      "transcription failure",
      "rejected queue",
      "left channel",
      "replaced capture",
      "short audio",
      "left during write",
    ] as const)("releases WAV input after %s without waiting for a timer", async (reason) => {
      const f = await fixture(
        reason === "transcription failure" ||
          reason === "rejected queue" ||
          reason === "replaced capture",
      );
      const blocked = createDeferred<void>();
      f.entry.processingQueue = blocked.promise;
      if (reason === "transcription failure") {
        transcribeAudioFileMock.mockRejectedValueOnce(new Error("STT unavailable"));
      } else if (reason === "left during write") {
        workspace.afterWrite = async () => {
          await f.manager.leave({ guildId: "g1" });
        };
      }
      try {
        await f.receive(reason === "short audio" ? Buffer.alloc(960) : undefined);
        if (reason === "left channel") {
          await f.manager.leave({ guildId: "g1" });
        } else if (reason === "replaced capture") {
          await startTranscripts(f.manager, vi.fn(), "replacement");
        }
        if (reason === "left during write") {
          expect(f.manager.status()).toEqual([]);
          expect(await fs.readdir(workspace.rootDir)).toEqual([]);
        }
        if (reason === "rejected queue") {
          blocked.reject(new Error("Previous processing failed"));
        } else {
          blocked.resolve();
        }
        await f.entry.processingQueue;
        await f.released();
        expect(f.sink).not.toHaveBeenCalled();
        if (reason === "transcription failure") {
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("STT unavailable"));
        } else {
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        }
        expect(await fs.readdir(workspace.rootDir)).toEqual([]);
      } finally {
        blocked.resolve();
        await f.entry.processingQueue;
        await f.released();
        await f.manager.destroy();
      }
    });
  },
);
