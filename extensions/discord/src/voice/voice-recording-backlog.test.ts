import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const voiceAudio = await import("./audio.js");

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
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
    it.each([
      { limit: "jobs", blocked: "transcription", frames: 1, attempts: 256, expectedFiles: 128 },
      { limit: "bytes", blocked: "publication", frames: 500, attempts: 40, expectedFiles: 34 },
    ] as const)(
      "bounds queued WAV $limit during stalled $blocked across reconnect",
      async (scenario) => {
        const manager = createManager(makeVoiceConfig(), undefined, {
          tools: { media: { audio: { maxBytes: scenario.frames * 3_840 + 44 } } },
        });
        const release = createDeferred<void>();
        const sink = vi.fn(async () => {
          if (scenario.blocked === "publication") {
            await release.promise;
          }
        });
        await startTranscripts(manager, sink);
        const entry = getSessionEntry(manager);
        decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
          try {
            for await (const packet of input) {
              await callbacks.onChunk(Buffer.alloc(3_840, packet[0]), packet);
            }
          } catch (error) {
            callbacks.onError?.(error);
          }
        });
        transcribeAudioFileMock.mockImplementation(async () => {
          if (scenario.blocked === "transcription") {
            await release.promise;
          }
          return { text: "Recorded speech" };
        });
        let created = createDeferred<void>();
        const files: Array<{ path: string; bytes: number }> = [];
        const writeWav = voiceAudio.writeVoiceWavFile;
        const writes = vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
          const wav = await writeWav(pcm);
          files.push({ path: wav.path, bytes: (await fs.stat(wav.path)).size });
          created.resolve();
          return wav;
        });
        const streams: PassThrough[] = [];
        const receive = (target = entry) => {
          const stream = new PassThrough({ objectMode: true });
          streams.push(stream);
          getSessionConnection(target).receiver.subscribe.mockReturnValueOnce(stream);
          const receiving = handleSpeakingStart(manager, target, "guest").catch(
            (error: unknown) => {
              if (!(error instanceof Error) || !error.message.includes("recording backlog")) {
                throw error;
              }
            },
          );
          return { stream, receiving };
        };
        const first = receive();
        try {
          for (let chunk = 0; chunk < scenario.attempts; chunk++) {
            created = createDeferred<void>();
            for (let frame = 0; frame < scenario.frames; frame++) {
              first.stream.write(Buffer.from([7]));
            }
            const continuing = await Promise.race([
              created.promise.then(() => true),
              first.receiving.then(() => false),
            ]);
            if (!continuing) {
              break;
            }
          }
          first.stream.end();
          await first.receiving;
          expect(files).toHaveLength(scenario.expectedFiles);
          expect(files.reduce((total, file) => total + file.bytes, 0)).toBeLessThanOrEqual(
            64 * 1024 * 1024,
          );
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("recording backlog"));
          expect(entry.transcripts?.isCurrent()).toBe(true);

          await manager.leave({ guildId: "g1" });
          expect(
            await manager.startTranscriptsCapture({ guildId: "g1", channelId: "1001" }),
          ).toMatchObject({ ok: true });
          const replacement = getSessionEntry(manager);
          const blocked = receive(replacement);
          for (let frame = 0; frame < scenario.frames; frame++) {
            blocked.stream.write(Buffer.from([8]));
          }
          blocked.stream.end();
          await blocked.receiving;
          expect(files).toHaveLength(scenario.expectedFiles);

          release.resolve();
          await entry.processingQueue;
          await Promise.all(
            files.map(async (file) => {
              await expect(fs.access(file.path)).rejects.toMatchObject({ code: "ENOENT" });
            }),
          );
          const calls = sink.mock.calls.length;
          const resumed = receive(replacement);
          resumed.stream.end(Buffer.from([9]));
          await resumed.receiving;
          await replacement.processingQueue;
          expect(files).toHaveLength(scenario.expectedFiles + 1);
          expect(sink).toHaveBeenCalledTimes(calls + 1);
          expect(replacement.transcripts?.isCurrent()).toBe(true);
        } finally {
          release.resolve();
          for (const stream of streams) {
            stream.end();
          }
          await first.receiving;
          await entry.processingQueue;
          await manager.destroy();
          writes.mockRestore();
        }
      },
    );
  },
);
