import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createDiscordRecordingFixture } from "./transcripts-recording.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const voiceIngress = await import("./ingress.js");
const voiceAudio = await import("./audio.js");

defineDiscordVoiceTests((harness) => {
  const {
    expect,
    it,
    vi,
    beginSpeakerTurn,
    getSessionConnection,
    startTranscripts,
    stopTranscripts,
    transcribeAudioFileMock,
    realtimeSessionMock,
    agentCommandMock,
    loggerWarnMock,
    controlRealtimeVoiceAgentRunMock,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
  } = harness;
  const fixture = createDiscordRecordingFixture(harness);

  it("keeps recording when realtime conversation has reached its speaker limit", async () => {
    const f = await fixture();
    await startTranscripts(f.manager, f.sink);
    for (let index = 0; index < 8; index++) {
      beginSpeakerTurn(f.entry, { userId: `guest-${index}`, senderIsOwner: false }).close();
    }
    await f.audio("100000000000000001", 7);
    expect(f.sink).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "audio-7-96000" }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("Voice is busy"));
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(f.entry.transcripts?.isCurrent()).toBe(true);
  });

  it.each(["agent-proxy", "stt-tts"] as const)(
    "records through stalled %s admission and retires only overflowing conversation audio",
    async (mode) => {
      const f = await fixture(mode, false, {
        tools: { media: { audio: { maxBytes: 192_044 } } },
      });
      await startTranscripts(f.manager, f.sink);
      const release = createDeferred<void>();
      const resolveIngress = voiceIngress.resolveDiscordVoiceIngressContext;
      const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
      authorize.mockImplementationOnce(async (params) => {
        await release.promise;
        return resolveIngress(params);
      });
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      try {
        for (let segment = 1; segment <= 6; segment++) {
          for (let frame = 0; frame < 50; frame++) {
            stream.write(Buffer.alloc(3_840, 8));
          }
          await vi.waitFor(() => expect(f.sink).toHaveBeenCalledTimes(segment));
        }
        expect(stream.destroyed).toBe(false);
        expect(loggerWarnMock).toHaveBeenCalledWith(
          expect.stringContaining("conversation audio backlog"),
        );
        expect(f.entry.transcripts?.isCurrent()).toBe(true);
        stream.end();
        release.resolve();
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink).toHaveBeenCalledTimes(6);
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        await f.audio("100000000000000001", 9);
        expect(f.sink).toHaveBeenCalledTimes(7);
        if (mode === "stt-tts") {
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } else {
          expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        stream.end();
        await receiving;
        await f.entry.processingQueue;
        authorize.mockRestore();
      }
    },
  );

  it.each(["chunk", "final"] as const)(
    "records subsequent speech while %s conversation authorization is stalled",
    async (phase) => {
      const f = await fixture("stt-tts");
      await startTranscripts(f.manager, f.sink);
      const queued = createDeferred<void>();
      f.entry.processingQueue = queued.promise;
      const resolveIngress = voiceIngress.resolveDiscordVoiceIngressContext;
      const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
      const authorized = createDeferred<null>();
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      try {
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
        await authorize.mock.results[0]!.value;
        stream.end(Buffer.alloc(96_000, 1));
        await vi.waitFor(() => expect(f.entry.processingQueue).not.toBe(queued.promise));
        if (phase === "final") {
          authorize.mockImplementationOnce(resolveIngress);
        }
        authorize.mockImplementationOnce(() => authorized.promise);
        queued.resolve();
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(phase === "final" ? 3 : 2));
        await vi.waitFor(() => expect(f.sink).toHaveBeenCalledOnce());
        const next = f.begin("guest");
        f.streams.get("guest")!.end(Buffer.alloc(96_000, 2));
        await next;
        await vi.waitFor(() => expect(f.sink).toHaveBeenCalledTimes(2));
        expect(agentCommandMock).not.toHaveBeenCalled();
        authorized.resolve(null);
        await receiving;
        await f.entry.processingQueue;
        await Promise.all(f.conversations.mock.results.map((result) => result.value));
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        queued.resolve();
        authorized.resolve(null);
        stream.end();
        await receiving;
        await f.entry.processingQueue;
        authorize.mockRestore();
      }
    },
  );

  it("keeps recording when queued conversation reauthorization fails", async () => {
    const f = await fixture("stt-tts");
    await startTranscripts(f.manager, f.sink);
    const queued = createDeferred<void>();
    f.entry.processingQueue = queued.promise;
    const receiving = f.begin("100000000000000001");
    f.streams.get("100000000000000001")!.end(Buffer.alloc(96_000, 1));
    await receiving;
    const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
    try {
      authorize.mockRejectedValue(new Error("Conversation authorization unavailable"));
      queued.resolve();
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "audio-1-96000" }),
      );
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining("Conversation authorization unavailable"),
      );
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    } finally {
      authorize.mockRestore();
      queued.resolve();
      await f.entry.processingQueue;
    }
    await f.audio("100000000000000001", 2);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(agentCommandMock).toHaveBeenCalledOnce();
  });

  it("bounds pending conversation admission while every speaker keeps recording", async () => {
    const f = await fixture("stt-tts");
    await startTranscripts(f.manager, f.sink);
    const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
    const authorized = createDeferred<null>();
    authorize.mockImplementation(() => authorized.promise);
    const receivers: Promise<void>[] = [];
    try {
      for (let index = 0; index < 9; index++) {
        const userId = `guest-${index}`;
        receivers.push(f.begin(userId));
        f.streams.get(userId)!.end(Buffer.alloc(96_000, index));
      }
      await Promise.all(receivers);
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledTimes(9);
      expect(authorize).toHaveBeenCalledTimes(8);
      expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("conversation is busy"));
      authorized.resolve(null);
      await Promise.all(f.conversations.mock.results.map((result) => result.value));
      expect(agentCommandMock).not.toHaveBeenCalled();
      authorize.mockRestore();
      await f.audio("100000000000000001", 9);
      expect(f.sink).toHaveBeenCalledTimes(10);
      expect(agentCommandMock).toHaveBeenCalledOnce();
    } finally {
      authorized.resolve(null);
      for (const stream of f.streams.values()) {
        stream.end();
      }
      await Promise.all(receivers);
      await f.entry.processingQueue;
      authorize.mockRestore();
    }
  });

  it("keeps recording later speech while a conversation response is pending", async () => {
    const f = await fixture("stt-tts");
    await startTranscripts(f.manager, f.sink);
    const response = createDeferred<{ payloads: [] }>();
    agentCommandMock.mockImplementationOnce(() => response.promise);
    const first = f.begin("100000000000000001");
    f.streams.get("100000000000000001")!.end(Buffer.alloc(96_000, 1));
    try {
      await first;
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
      const next = f.begin("guest");
      f.streams.get("guest")!.end(Buffer.alloc(96_000, 2));
      await next;
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledTimes(2);
      response.resolve({ payloads: [] });
      await Promise.all(f.conversations.mock.results.map((result) => result.value));
      expect(agentCommandMock).toHaveBeenCalledOnce();
    } finally {
      response.resolve({ payloads: [] });
      await first;
      await f.entry.processingQueue;
    }
  });

  it.each([false, true])(
    "keeps recording when realtime audio delivery fails (close failure=%s)",
    async (closeFailure) => {
      const f = await fixture();
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      try {
        stream.write(Buffer.alloc(96_000, 1));
        await vi.waitFor(() => expect(realtimeSessionMock.sendAudio).toHaveBeenCalledOnce());
        realtimeSessionMock.sendAudio.mockImplementationOnce(() => {
          throw new Error("Realtime audio delivery unavailable");
        });
        if (closeFailure) {
          realtimeSessionMock.close.mockImplementationOnce(() => {
            throw new Error("Realtime provider close failed");
          });
        }
        stream.end(Buffer.alloc(96_000, 2));
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "audio-1-192000" }),
        );
        await emitFinalRealtimeUserTranscript(
          lastRealtimeBridgeParams(),
          "Send incomplete request",
        );
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        expect(f.entry.transcripts?.isCurrent()).toBe(true);
      } finally {
        stream.end();
        await receiving;
        await f.entry.processingQueue;
      }
    },
  );

  it.each(["allowed", "denied", "failed"] as const)(
    "starts recording while conversation admission is pending and later %s",
    async (outcome) => {
      const f = await fixture();
      const userId = outcome === "allowed" ? "100000000000000001" : "guest";
      const release = createDeferred<void>();
      const resolveIngress = voiceIngress.resolveDiscordVoiceIngressContext;
      const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
      authorize.mockImplementationOnce(async (params) => {
        await release.promise;
        if (outcome === "failed") {
          throw new Error("Conversation authorization unavailable");
        }
        return resolveIngress(params);
      });
      const receiving = f.begin(userId);
      const settled = receiving.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
        expect(f.streams.size).toBe(0);
        f.entry.connection.receiver.speaking.users.set(userId, Date.now());
        await startTranscripts(f.manager, f.sink);
        await vi.waitFor(() => expect(f.streams.has(userId)).toBe(true));
        f.streams.get(userId)!.end(Buffer.alloc(96_000, 8));
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        release.resolve();
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "audio-8-96000" }),
        );
        expect(getSessionConnection(f.entry).receiver.subscribe).toHaveBeenCalledOnce();
        expect(authorize).toHaveBeenCalledOnce();
        if (outcome === "allowed") {
          expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
        } else {
          expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        }
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await f.manager.destroy();
        f.streams.get(userId)?.end();
        await settled;
        authorize.mockRestore();
      }
    },
  );

  it.each([
    { wait: "queued", result: "allowed" },
    { wait: "queued", result: "denied" },
    { wait: "queued", result: "retired" },
    { wait: "identity", result: "allowed" },
    { wait: "identity", result: "denied" },
    { wait: "identity", result: "retired" },
  ] as const)(
    "records a replacement while retired $wait audio waits for $result conversation authority",
    async ({ wait, result }) => {
      const f = await fixture("stt-tts");
      await startTranscripts(f.manager, f.sink);
      const queued = createDeferred<void>();
      const identity = createDeferred<void>();
      const identityStarted = createDeferred<void>();
      const authorized = createDeferred<{ speakerLabel: string; senderIsOwner: boolean } | null>();
      if (wait === "queued") {
        f.entry.processingQueue = queued.promise;
      }
      const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
      const writeWav = voiceAudio.writeVoiceWavFile;
      const files: Array<{ path: string; released: ReturnType<typeof createDeferred<void>> }> = [];
      const writes = vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
        const wav = await writeWav(pcm);
        const released = createDeferred<void>();
        files.push({ path: wav.path, released });
        return {
          ...wav,
          cleanup: async () => {
            await wav.cleanup();
            released.resolve();
          },
        };
      });
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      const replacement = vi.fn();
      let next: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
        await authorize.mock.results[0]!.value;
        if (wait === "identity") {
          const member = f.client.fetchMember.getMockImplementation()!;
          f.client.fetchMember.mockImplementationOnce(async (...args) => {
            identityStarted.resolve();
            await identity.promise;
            return member(...args);
          });
        }
        authorize.mockImplementationOnce(() => authorized.promise);
        stream.end(Buffer.alloc(96_000, 1));
        await receiving;
        if (wait === "identity") {
          await identityStarted.promise;
          await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
        }
        expect(files).toHaveLength(1);
        await stopTranscripts();
        await startTranscripts(f.manager, replacement, "notes-2");
        queued.resolve();
        identity.resolve();
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
        next = f.begin("100000000000000001");
        f.streams.get("100000000000000001")!.end(Buffer.alloc(96_000, 2));
        await next;
        await vi.waitFor(() =>
          expect(replacement).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionId: "notes-2", text: "audio-2-96000" }),
          ),
        );
        expect(f.sink).not.toHaveBeenCalled();
        expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
        await fs.access(files[0]!.path);
        if (result === "retired") {
          await f.manager.leave({ guildId: "g1" });
          await files[0]!.released.promise;
        }
        authorized.resolve(
          result === "denied" ? null : { speakerLabel: "Owner", senderIsOwner: true },
        );
        await Promise.all(f.conversations.mock.results.map((call) => call.value));
        await Promise.all(files.map((file) => file.released.promise));
        expect(f.sink).not.toHaveBeenCalled();
        expect(replacement).toHaveBeenCalledOnce();
        if (result === "allowed") {
          expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2);
          expect(agentCommandMock.mock.calls.map(([call]) => call)).toEqual([
            expect.objectContaining({ message: expect.stringContaining("audio-1-96000") }),
            expect.objectContaining({ message: expect.stringContaining("audio-2-96000") }),
          ]);
        } else {
          expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
          expect(agentCommandMock).toHaveBeenCalledTimes(result === "retired" ? 0 : 1);
        }
      } finally {
        queued.resolve();
        identity.resolve();
        authorized.resolve(null);
        stream.end();
        await receiving;
        await next;
        await f.entry.processingQueue;
        await f.manager.destroy();
        await Promise.all(f.conversations.mock.results.map((call) => call.value));
        await Promise.all(files.map((file) => file.released.promise));
        writes.mockRestore();
        authorize.mockRestore();
      }
    },
  );

  it.each(["session", "input"] as const)(
    "does not transcribe after granted conversation %s retires during recording identity",
    async (retirement) => {
      const f = await fixture("stt-tts", false, {
        tools: { media: { audio: { maxBytes: 192_044 } } },
      });
      await startTranscripts(f.manager, f.sink);
      const identity = createDeferred<void>();
      const identityStarted = createDeferred<void>();
      const released = createDeferred<void>();
      const authorize = vi.spyOn(voiceIngress, "resolveDiscordVoiceIngressContext");
      const writeWav = voiceAudio.writeVoiceWavFile;
      const writes = vi
        .spyOn(voiceAudio, "writeVoiceWavFile")
        .mockImplementationOnce(async (pcm) => {
          const wav = await writeWav(pcm);
          return {
            ...wav,
            cleanup: async () => {
              await wav.cleanup();
              released.resolve();
            },
          };
        });
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      try {
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
        await authorize.mock.results[0]!.value;
        const member = f.client.fetchMember.getMockImplementation()!;
        f.client.fetchMember.mockImplementationOnce(async (...args) => {
          identityStarted.resolve();
          await identity.promise;
          return member(...args);
        });
        stream.write(Buffer.alloc(192_000, 1));
        await identityStarted.promise;
        await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
        await authorize.mock.results[1]!.value;
        await stopTranscripts();
        if (retirement === "session") {
          await f.manager.leave({ guildId: "g1" });
        } else {
          stream.destroy(new Error("Receive socket failed"));
        }
        await receiving;
        identity.resolve();
        await released.promise;
        expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        expect(f.sink).not.toHaveBeenCalled();
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        identity.resolve();
        stream.end();
        await receiving;
        await released.promise;
        await f.entry.processingQueue;
        await f.manager.destroy();
        writes.mockRestore();
        authorize.mockRestore();
      }
    },
  );
});
