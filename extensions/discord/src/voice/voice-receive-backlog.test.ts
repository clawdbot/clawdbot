import { AudioReceiveStream, EndBehaviorType } from "@discordjs/voice";
import { createEncoder } from "libopus-wasm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createClientWithMember,
    createConnectionMock,
    joinVoiceChannelMock,
    createManager,
    createAgentProxyManager,
    beginSpeakerTurn,
    lastRealtimeBridge,
    emitFinalRealtimeUserTranscript,
    makeVoiceConfig,
    getSessionEntry,
    handleSpeakingStart,
    startTranscripts,
    stopTranscripts,
    transcribeAudioFileMock,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    loggerWarnMock,
    decodeOpusStreamChunksMock,
  }) => {
    it.each(["admission", "decoder"])(
      "bounds packets while %s is pending without retiring the room capture",
      async (stage) => {
        const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
        const blocked = createDeferred<void>();
        decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
          if (stage === "decoder") {
            await blocked.promise;
          }
          await actual.decodeOpusStreamChunks(input, params);
        });
        const client = createClientWithMember("u-speaker", "Speaker", "0");
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
          client,
          { tools: { media: { audio: { maxBytes: 192_044 } } } },
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const sink = vi.fn();
        await startTranscripts(manager, sink);
        const entry = getSessionEntry(manager);
        const capture = entry.transcripts;
        const conversations = vi.spyOn(entry.conversations, "enqueue");
        if (stage === "admission") {
          client.fetchMember.mockImplementationOnce(async () => {
            await blocked.promise;
            return { user: { id: "u-speaker" } };
          });
        }
        const stream = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = handleSpeakingStart(manager, entry, "u-speaker");
        // The SDK's UDP producer ignores push() backpressure. These valid 20 ms
        // Opus silence frames must stay bounded before identity or decode settles.
        try {
          for (let frame = 0; frame < 2_000; frame++) {
            stream.push(Buffer.from([0xf8, 0xff, 0xfe]));
          }
          await vi.waitFor(() => expect(stream.destroyed).toBe(true));
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("receive backlog"));
          expect(entry.capture.size).toBe(0);
          blocked.resolve();
          await receiving;
          await entry.processingQueue;
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
          expect(sink).not.toHaveBeenCalled();
          expect(entry.capture.size).toBe(0);
          expect(entry.transcripts).toBe(capture);
          expect(entry.sessionLifecycle.status).toBe("active");

          const next = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
          connection.receiver.subscribe.mockReturnValueOnce(next);
          const resumed = handleSpeakingStart(manager, entry, "u-speaker");
          for (let frame = 0; frame < 20; frame++) {
            next.push(Buffer.from([0xf8, 0xff, 0xfe]));
          }
          next.push(null);
          await resumed;
          await entry.processingQueue;
          await Promise.all(conversations.mock.results.map((result) => result.value));
          expect(sink).toHaveBeenCalledOnce();
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } finally {
          await stopTranscripts();
          await manager.destroy();
          stream.destroy();
          blocked.resolve();
          await receiving;
          await entry.processingQueue;
        }
      },
    );
    it.each([true, false])(
      "bounds encoded bytes with batch transcription enabled=%s",
      async (enabled) => {
        const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
        const blocked = createDeferred<void>();
        decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
          await blocked.promise;
          await actual.decodeOpusStreamChunks(input, params);
        });
        const client = createClientWithMember("u-speaker", "Speaker", "0");
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createAgentProxyManager(
          client,
          { allowFrom: ["discord:u-speaker"] },
          { tools: { media: { audio: { enabled } } } },
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        const stream = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = handleSpeakingStart(manager, entry, "u-speaker");
        try {
          await vi.waitFor(() => expect(connection.receiver.subscribe).toHaveBeenCalled());
          const encoder = await createEncoder({
            channels: 2,
            sampleRate: 48_000,
            bitrate: 512_000,
            vbr: false,
          });
          let packet: Buffer;
          try {
            packet = Buffer.from(encoder.encode(new Int16Array(1_920), { frameSize: 960 }));
          } finally {
            encoder.free();
          }
          // High-bitrate Opus crosses the byte bound before the packet-count bound.
          for (let frame = 0; frame < 950; frame++) {
            stream.push(packet);
          }
          await vi.waitFor(() => expect(stream.destroyed).toBe(true));
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("receive backlog"));
          blocked.resolve();
          await receiving;
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(entry.sessionLifecycle.status).toBe("active");
          expect(entry.capture.size).toBe(0);
        } finally {
          stream.destroy();
          blocked.resolve();
          await receiving;
          await manager.destroy();
        }
      },
    );

    it.each(["backlog", "decoder", "decryption", "stream"] as const)(
      "retires only the incomplete realtime speaker after a %s failure",
      async (failure) => {
        const audio = await import("./audio.js");
        const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
        decodeOpusStreamChunksMock.mockImplementation(actual.decodeOpusStreamChunks);
        const diskStarted = createDeferred<void>();
        const diskReady = createDeferred<void>();
        const write = vi.spyOn(audio, "writeVoiceWavFile").mockImplementationOnce(async (pcm) => {
          diskStarted.resolve();
          await diskReady.promise;
          return await actual.writeVoiceWavFile(pcm);
        });
        const client = createClientWithMember("u-speaker", "Speaker", "0");
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createAgentProxyManager(
          client,
          { allowFrom: ["discord:u-speaker"], voice: { realtime: { requireWakeName: false } } },
          { tools: { media: { audio: { maxBytes: 3_884 } } } },
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const sink = vi.fn();
        await startTranscripts(manager, sink);
        const entry = getSessionEntry(manager);
        const capture = entry.transcripts;
        beginSpeakerTurn(entry, { userId: "u-other", senderIsOwner: false }).close();
        const other = lastRealtimeBridge();
        const stream = new AudioReceiveStream({ end: { behavior: EndBehaviorType.Manual } });
        connection.receiver.subscribe.mockReturnValueOnce(stream);
        const receiving = handleSpeakingStart(manager, entry, "u-speaker");
        try {
          stream.push(Buffer.from([0xf8, 0xff, 0xfe]));
          await diskStarted.promise;
          const interrupted = lastRealtimeBridge();
          expect(interrupted.session).not.toBe(other.session);
          if (failure === "backlog") {
            for (let frame = 0; frame < 2_000; frame++) {
              stream.push(Buffer.from([0xf8, 0xff, 0xfe]));
            }
          } else if (failure === "decoder") {
            stream.push(Buffer.from([0xff]));
            diskReady.resolve();
            await receiving;
          } else {
            stream.destroy(
              new Error(failure === "decryption" ? "Failed to decrypt" : "Receive socket failed"),
            );
          }
          await vi.waitFor(() => expect(stream.destroyed).toBe(true));
          await emitFinalRealtimeUserTranscript(
            interrupted.bridgeParams,
            "Send the incomplete request",
          );
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(interrupted.session.close).toHaveBeenCalledOnce();
          expect(other.session.close).not.toHaveBeenCalled();
          expect(entry.transcripts).toBe(capture);
          expect(entry.sessionLifecycle.status).toBe("active");
          await emitFinalRealtimeUserTranscript(other.bridgeParams, "Read the complete request");
          expect(agentCommandMock).toHaveBeenCalledOnce();
          diskReady.resolve();
          await receiving;
          await entry.processingQueue;
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(entry.capture.size).toBe(0);
        } finally {
          diskReady.resolve();
          stream.destroy();
          await receiving;
          await entry.processingQueue;
          write.mockRestore();
          await stopTranscripts();
          await manager.destroy();
        }
      },
    );
  },
);
