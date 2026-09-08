import { PassThrough } from "node:stream";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    handleSpeakingStart,
    transcribeAudioFileMock,
    loggerWarnMock,
    decodeOpusStreamChunksMock,
  }) => {
    it.each([0, -1])(
      "accounts for the WAV header at the transcription limit (offset %i)",
      async (offset) => {
        decodeOpusStreamChunksMock.mockImplementation(
          (await vi.importActual<typeof import("./audio.js")>("./audio.js")).decodeOpusStreamChunks,
        );
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
          undefined,
          { tools: { media: { audio: { maxBytes: 20 * 3840 + 44 + offset } } } },
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        const conversations = vi.spyOn(entry.conversations, "enqueue");
        const stream = new PassThrough({ objectMode: true });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const completion = handleSpeakingStart(manager, entry, "u-speaker");
        const outcome =
          offset === 0
            ? expect(completion).resolves.toBeUndefined()
            : expect(completion).rejects.toThrow("speak a shorter segment");
        for (let frame = 0; frame < 20; frame += 1) {
          stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
        }
        stream.end();
        await outcome;
        await entry.processingQueue;
        await Promise.all(conversations.mock.results.map((result) => result.value));
        expect(transcribeAudioFileMock).toHaveBeenCalledTimes(offset === 0 ? 1 : 0);
        expect(stream.destroyed).toBe(true);
        expect(entry.capture.size).toBe(0);
        if (offset < 0) {
          expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.stringContaining("speak a shorter segment"),
          );
        }
        await manager.destroy();
      },
    );

    it("allows the same speaker to restart after an oversized capture without transcribing a prefix", async () => {
      decodeOpusStreamChunksMock.mockImplementation(
        (await vi.importActual<typeof import("./audio.js")>("./audio.js")).decodeOpusStreamChunks,
      );
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
        undefined,
        { tools: { media: { audio: { maxBytes: 20 * 3840 + 44 } } } },
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const conversations = vi.spyOn(entry.conversations, "enqueue");
      for (const frames of [21, 20]) {
        const stream = new PassThrough({ objectMode: true });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const completion = handleSpeakingStart(manager, entry, "u-speaker");
        const outcome =
          frames === 21
            ? expect(completion).rejects.toThrow("speak a shorter segment")
            : expect(completion).resolves.toBeUndefined();
        for (let frame = 0; frame < frames; frame += 1) {
          stream.write(Buffer.from([0xf8, 0xff, 0xfe]));
        }
        stream.end();
        await outcome;
        await entry.processingQueue;
        await Promise.all(conversations.mock.results.map((result) => result.value));
        expect(transcribeAudioFileMock).toHaveBeenCalledTimes(frames === 21 ? 0 : 1);
        expect(stream.destroyed).toBe(true);
        expect(entry.capture.size).toBe(0);
      }
      await manager.destroy();
    });

    it("records disabled batch transcription without decoding or retaining a capture", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager(undefined, undefined, {
        tools: { media: { audio: { enabled: false } } },
      });
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValueOnce(stream);
      await handleSpeakingStart(manager, entry, "u-speaker");
      expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("audio understanding is disabled"),
      );
      expect(stream.destroyed).toBe(true);
      expect(entry.capture.size).toBe(0);
      await manager.destroy();
    });
  },
);
