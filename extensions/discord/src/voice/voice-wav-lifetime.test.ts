import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const workspace = vi.hoisted(() => ({ rootDir: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => workspace.rootDir,
}));

defineDiscordVoiceTests(
  ({
    expect,
    it,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    handleSpeakingStart,
    decodeOpusStreamMock,
    transcribeAudioFileMock,
    loggerWarnMock,
  }) => {
    beforeEach(async () => {
      workspace.rootDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-wav-lifetime-")),
      );
    });
    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await fs.rm(workspace.rootDir, { recursive: true, force: true });
    });

    async function fixture() {
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:guest"] }),
        createClientWithMember("guest", "Guest", "1234"),
      );
      const sink = vi.fn();
      await manager.join(
        { guildId: "g1", channelId: "1001" },
        { transcripts: { sessionId: "notes", onUtterance: sink } },
      );
      decodeOpusStreamMock.mockResolvedValueOnce(Buffer.alloc(192_000));
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
        return { text: "Meeting notes" };
      });
      return { manager, entry: getSessionEntry(manager), sink };
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
          await handleSpeakingStart(f.manager, f.entry, "guest");
          if (phase === "transcribing") {
            await transcribing.promise;
          }
          await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
          await Promise.all(removals.mock.results.map((result) => result.value));
          expect(await fs.readdir(workspace.rootDir)).toHaveLength(1);
          blocked.resolve();
          await f.entry.processingQueue;
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ text: "Meeting notes" }),
          );
          expect(await fs.readdir(workspace.rootDir)).toEqual([]);
        } finally {
          blocked.resolve();
          await f.entry.processingQueue;
          await f.manager.destroy();
        }
      },
    );

    it.each([
      "transcription failure",
      "left channel",
      "replaced capture",
      "short audio",
      "left during write",
    ] as const)("releases WAV input after %s without waiting for a timer", async (reason) => {
      const f = await fixture();
      const blocked = createDeferred<void>();
      f.entry.processingQueue = blocked.promise;
      if (reason === "transcription failure") {
        transcribeAudioFileMock.mockRejectedValueOnce(new Error("STT unavailable"));
      } else if (reason === "short audio") {
        decodeOpusStreamMock.mockReset().mockResolvedValueOnce(Buffer.alloc(960));
      } else if (reason === "left during write") {
        const audio = await import("./audio.js");
        const writeWav = audio.writeVoiceWavFile;
        vi.spyOn(audio, "writeVoiceWavFile").mockImplementationOnce(async (pcm) => {
          const wav = await writeWav(pcm);
          await f.manager.leave({ guildId: "g1" });
          return wav;
        });
      }
      try {
        await handleSpeakingStart(f.manager, f.entry, "guest");
        if (reason === "left channel") {
          await f.manager.leave({ guildId: "g1" });
        } else if (reason === "replaced capture") {
          await f.manager.join(
            { guildId: "g1", channelId: "1001" },
            { transcripts: { sessionId: "replacement", onUtterance: vi.fn() } },
          );
        }
        blocked.resolve();
        await f.entry.processingQueue;
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
        await f.manager.destroy();
      }
    });
  },
);
