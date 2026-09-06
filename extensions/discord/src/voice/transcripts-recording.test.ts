import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createDiscordRecordingFixture } from "./transcripts-recording.test-support.js";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const voiceAudio = await import("./audio.js");

defineDiscordVoiceTests((harness) => {
  const {
    expect,
    expectDefined,
    it,
    vi,
    getSessionConnection,
    getLastAudioPlayer,
    startTranscripts,
    stopTranscripts,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    resolveAudioInputBudgetMock,
    realtimeSessionMock,
    agentCommandMock,
    loggerWarnMock,
    controlRealtimeVoiceAgentRunMock,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    updateVoiceState,
    joinVoiceChannelMock,
    expectConnectedStatus,
  } = harness;
  const fixture = createDiscordRecordingFixture(harness);

  it.each(["fresh", "replacement"] as const)(
    "rejects disabled batch recording before changing %s ownership",
    async (phase) => {
      const config = { channels: { discord: { token: "test-token", voice: { enabled: true } } } };
      const disabledAudio = { ...config, tools: { media: { audio: { enabled: false } } } };
      const f = await fixture("stt-tts", false, phase === "replacement" ? {} : disabledAudio);
      const source = {
        providerId: "discord-voice",
        accountId: "default",
        guildId: "g1",
        channelId: "1001",
      };
      const onStatus = vi.fn();
      setDiscordTranscriptsVoiceManager({ accountId: "default", manager: f.manager });
      try {
        if (phase === "fresh") {
          await f.manager.leave({ guildId: "g1" });
        } else if (phase === "replacement") {
          expect(
            await discordVoiceTranscriptsSourceProvider.start!({
              cfg: config,
              session: { sessionId: "first", source, startedAt: new Date().toISOString() },
              onUtterance: f.sink,
              onStatus,
            }),
          ).toMatchObject({ ok: true });
        }
        const joins = joinVoiceChannelMock.mock.calls.length;
        expect(
          await discordVoiceTranscriptsSourceProvider.start!({
            cfg: disabledAudio,
            session: { sessionId: "unsupported", source, startedAt: new Date().toISOString() },
            onUtterance: vi.fn(),
          }),
        ).toMatchObject({ ok: false, error: expect.stringContaining("tools.media.audio.enabled") });
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(joins);
        expect(onStatus).not.toHaveBeenCalled();
        expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject(
          phase === "replacement" ? [{ active: true, sessionId: "first" }] : [],
        );
        if (phase === "fresh") {
          expect(f.manager.status()).toEqual([]);
        } else {
          expectConnectedStatus(f.manager, "1001");
          await f.audio("100000000000000001", 1);
          expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
          if (phase === "replacement") {
            expect(f.sink).toHaveBeenCalledOnce();
          } else {
            expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          }
        }
      } finally {
        await discordVoiceTranscriptsSourceProvider.stop!({ sessionId: "first", source });
        await discordVoiceTranscriptsSourceProvider.stop!({ sessionId: "unsupported", source });
        setDiscordTranscriptsVoiceManager({
          accountId: "default",
          manager: null,
          expectedManager: f.manager,
        });
        await f.manager.destroy();
      }
    },
  );

  it.each(["agent-proxy", "bidi"] as const)(
    "records overlapping participants once with receiver IDs in %s",
    async (mode) => {
      const f = await fixture(mode);
      await startTranscripts(f.manager, f.sink);
      const starts = ["100000000000000001", "guest-a", "guest-b"].map(f.begin);
      // The packet that triggered speaking.start is delivered immediately after the listener.
      expect([...f.streams.keys()]).toEqual(["100000000000000001", "guest-a", "guest-b"]);
      for (const [index, stream] of [...f.streams.values()].entries()) {
        stream.end(Buffer.alloc(96_000, index + 1));
      }
      await Promise.all(starts);
      await f.entry.processingQueue;
      expect(
        f.sink.mock.calls
          .map(([u]) => [u.speaker.id, u.speaker.label, u.text])
          .toSorted(([leftSpeakerId], [rightSpeakerId]) =>
            leftSpeakerId.localeCompare(rightSpeakerId),
          ),
      ).toEqual([
        ["100000000000000001", "Owner", "audio-1-96000"],
        ["guest-a", "Guest", "audio-2-96000"],
        ["guest-b", "Guest", "audio-3-96000"],
      ]);
      expect(decodeOpusStreamChunksMock).toHaveBeenCalledTimes(3);
      expect(transcribeAudioFileMock).toHaveBeenCalledTimes(3);
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "ambient mixed final");
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "second mixed final");
      expect(f.sink).toHaveBeenCalledTimes(3);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    },
  );

  it("records protected-playback speech without interruption or conversational fallthrough", async () => {
    const f = await fixture();
    await startTranscripts(f.manager, f.sink);
    const player = getLastAudioPlayer();
    player.state.status = "playing";
    const stopCalls = player.stop.mock.calls.length;
    await Promise.all([f.audio("100000000000000001", 1), f.audio("guest", 2)]);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(player.stop).toHaveBeenCalledTimes(stopCalls);
    expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("shares one batch transcription between recording and authorized conversation", async () => {
    const f = await fixture("stt-tts");
    await startTranscripts(f.manager, f.sink);
    await f.audio("100000000000000001", 1);
    await f.audio("guest", 2);
    expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2);
    expect(f.sink).toHaveBeenCalledTimes(2);
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
  });

  it.each([
    { excluded: 1, dispatch: "conversation" },
    { excluded: 2, dispatch: "conversation" },
    { excluded: 1, dispatch: "control" },
    { excluded: 2, dispatch: "control" },
  ])(
    "withholds $dispatch after chunk $excluded loses authorization",
    async ({ excluded, dispatch }) => {
      const f = await fixture(
        "stt-tts",
        false,
        {
          tools: { media: { audio: { maxBytes: 192_044 } } },
        },
        true,
      );
      let allowed = true;
      f.client.fetchMember.mockImplementation(async (_guild, userId) => ({
        nickname: "Guest",
        roles: allowed ? ["200000000000000001"] : [],
        user: { id: userId },
      }));
      const texts =
        dispatch === "control"
          ? ["please", "do not", "stop that"]
          : ["Opening", "do not", "send the update"];
      if (dispatch === "control") {
        controlRealtimeVoiceAgentRunMock.mockResolvedValue({
          ok: true,
          mode: "cancel",
          active: true,
          aborted: true,
          sessionKey: expectDefined(f.entry.route?.sessionKey, "voice session route"),
          message: "Cancelled",
          speak: false,
          show: true,
          suppress: true,
        });
      }
      const writeWav = voiceAudio.writeVoiceWavFile;
      const wavSpy = vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
        // Admission has completed; change the observed member roles before the chunk's queue check.
        allowed = pcm[0] !== excluded;
        return writeWav(pcm);
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        return { text: texts[wav.readUInt8(44) - 1] };
      });
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin("guest");
      const stream = f.streams.get("guest")!;
      try {
        for (let marker = 1; marker <= 3; marker++) {
          const recorded = createDeferred<void>();
          f.sink.mockImplementationOnce(() => recorded.resolve());
          stream.write(Buffer.alloc(192_000, marker));
          await recorded.promise;
          expect(f.sink).toHaveBeenCalledTimes(marker);
          await f.entry.processingQueue;
          expect(wavSpy).toHaveBeenCalledTimes(marker);
          expect(allowed).toBe(marker !== excluded);
        }
        allowed = true;
        stream.end();
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink.mock.calls.map(([u]) => u.text)).toEqual(texts);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        transcribeAudioFileMock.mockResolvedValue({ text: "A complete new request" });
        await f.audio("guest", 4);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(f.sink).toHaveBeenCalledTimes(4);
      } finally {
        stream.end();
        await receiving;
        await f.entry.processingQueue;
        wavSpy.mockRestore();
      }
    },
  );

  it.each([
    { mode: "agent-proxy", ownFailure: false },
    { mode: "agent-proxy", ownFailure: true },
    { mode: "stt-tts", ownFailure: false },
    { mode: "stt-tts", ownFailure: true },
  ] as const)(
    "retains failures after decode while $mode admission waits (own=$ownFailure)",
    async ({ mode, ownFailure }) => {
      const f = await fixture(mode);
      await startTranscripts(f.manager, f.sink);
      await f.audio("100000000000000001", 7);
      const release = createDeferred<void>();
      const decoded = createDeferred<void>();
      const member = f.client.fetchMember.getMockImplementation()!;
      f.client.fetchMember.mockImplementationOnce(async (...args) => {
        await release.promise;
        return member(...args);
      });
      decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
        for await (const packet of input) {
          decoded.resolve();
          await params.onChunk(packet, packet);
        }
      });
      const audioCalls = realtimeSessionMock.sendAudio.mock.calls.length;
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      stream.write(Buffer.alloc(96_000, 8));
      await decoded.promise;
      const others: Promise<void>[] = [];
      const fail = (userId: string) => {
        others.push(f.begin(userId));
        f.streams.get(userId)!.destroy(new Error("DecryptionFailed(InvalidCiphertext)"));
      };
      try {
        if (ownFailure) {
          stream.destroy(new Error("DecryptionFailed(InvalidCiphertext)"));
        } else {
          fail("failed-1");
        }
        fail("failed-2");
        await vi.waitFor(() => expect(f.entry.receiveRecovery.decryptFailureCount).toBe(2));
        release.resolve();
        if (!ownFailure) {
          stream.end();
        }
        await receiving;
        await Promise.all(others);
        await f.entry.processingQueue;
        expect(f.entry.receiveRecovery.decryptFailureCount).toBe(2);
        if (ownFailure) {
          expect(realtimeSessionMock.sendAudio.mock.calls.length).toBe(audioCalls);
          expect(f.sink).toHaveBeenCalledOnce();
        } else {
          expect(f.sink).toHaveBeenCalledTimes(2);
        }
        fail("failed-3");
        await Promise.all(others);
        await vi.waitFor(() => {
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
          expectConnectedStatus(f.manager, "1001");
        });
      } finally {
        release.resolve();
        stream.end();
        await receiving;
        await Promise.all(others);
      }
    },
  );

  it.each(["normal", "decoder failure"])(
    "finalizes batch conversation after %s utterance end",
    async (ending) => {
      const f = await fixture("stt-tts", false, {
        tools: { media: { audio: { maxBytes: 192_044 } } },
      });
      if (ending === "decoder failure") {
        decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
          for await (const packet of input) {
            if (packet[0] === 2) {
              params.onError?.(new Error("memory access out of bounds"));
              return;
            }
            await params.onChunk(packet, packet);
          }
        });
      }
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      stream.write(Buffer.alloc(192_000, 1));
      await vi.waitFor(() => expect(f.sink).toHaveBeenCalledOnce());
      await f.entry.processingQueue;
      try {
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        stream.end(Buffer.alloc(192_000, 2));
        await receiving;
        await f.entry.processingQueue;
        await Promise.all(f.conversations.mock.results.map((result) => result.value));
      }
      if (ending === "decoder failure") {
        expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
        expect(f.sink).toHaveBeenCalledOnce();
        expect(agentCommandMock).not.toHaveBeenCalled();
      } else {
        expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2);
        expect(f.sink).toHaveBeenCalledTimes(2);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining("audio-1-192000\naudio-2-192000"),
        });
      }
    },
  );

  it.each([
    { dispatch: "conversation", middle: "failure" },
    { dispatch: "control", middle: "failure" },
    { dispatch: "conversation", middle: "success" },
    { dispatch: "control", middle: "success" },
    { dispatch: "conversation", middle: "empty" },
    { dispatch: "conversation", middle: "cleanup failure" },
  ])(
    "settles every chunk before $dispatch dispatch with middle $middle",
    async ({ dispatch, middle }) => {
      const f = await fixture("stt-tts", false, {
        tools: { media: { audio: { maxBytes: 192_044 } } },
      });
      await startTranscripts(f.manager, f.sink);
      const texts =
        dispatch === "control"
          ? ["please", "now", "stop that"]
          : ["Opening context", "middle context", "closing context"];
      const sessionKey = expectDefined(f.entry.route?.sessionKey, "voice session route");
      const release = createDeferred<void>();
      const wavPaths: string[] = [];
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        wavPaths.push(filePath);
        const wav = await fs.readFile(filePath);
        const marker = wav.readUInt8(44);
        if (marker === 2) {
          await release.promise;
          if (middle === "failure") {
            throw new Error("synthetic transcription failure");
          }
          if (middle === "empty") {
            return { text: undefined };
          }
        }
        return { text: texts[marker - 1] };
      });
      controlRealtimeVoiceAgentRunMock.mockResolvedValue({
        ok: true,
        mode: "cancel",
        sessionKey,
        active: true,
        aborted: true,
        message: "Cancelled",
        speak: false,
        show: true,
        suppress: true,
      });
      const writeWav = voiceAudio.writeVoiceWavFile;
      const cleanupSpy =
        middle === "cleanup failure"
          ? vi.spyOn(voiceAudio, "writeVoiceWavFile").mockImplementation(async (pcm) => {
              const wav = await writeWav(pcm);
              return {
                ...wav,
                cleanup: async () => {
                  await wav.cleanup();
                  if (pcm[0] === 2) {
                    throw new Error("synthetic cleanup failure after disposal");
                  }
                },
              };
            })
          : undefined;
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      stream.write(Buffer.alloc(192_000, 1));
      stream.write(Buffer.alloc(192_000, 2));
      stream.end(Buffer.alloc(192_000, 3));
      try {
        // Speech ends while the middle STT request is still pending, so the finalizer
        // is already queued before its outcome is known.
        await receiving;
        await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledTimes(2));
        expect(f.sink.mock.calls.map(([utterance]) => utterance.text)).toEqual([texts[0]]);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await f.entry.processingQueue;
        cleanupSpy?.mockRestore();
      }
      if (middle === "cleanup failure") {
        expect(loggerWarnMock).toHaveBeenCalledWith(
          expect.stringContaining("synthetic cleanup failure after disposal"),
        );
      }
      const savedTexts = middle === "failure" || middle === "empty" ? [texts[0], texts[2]] : texts;
      expect(f.sink.mock.calls.map(([utterance]) => utterance.text)).toEqual(savedTexts);
      expect(wavPaths).toHaveLength(3);
      for (const wavPath of wavPaths) {
        await expect(fs.access(wavPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (middle === "failure") {
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        // A failed utterance must not poison the next one on the same receiver.
        transcribeAudioFileMock.mockResolvedValue({ text: "A complete new request" });
        await f.audio("100000000000000001", 4);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(f.sink).toHaveBeenLastCalledWith(
          expect.objectContaining({ text: "A complete new request" }),
        );
      } else if (dispatch === "control") {
        expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledExactlyOnceWith({
          sessionKey,
          text: texts.join("\n"),
        });
        expect(agentCommandMock).not.toHaveBeenCalled();
      } else {
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining(savedTexts.join("\n")),
        });
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { transition: "enable", speech: "short conversation" },
    { transition: "disable", speech: "short conversation" },
    { transition: "enable", speech: "short control" },
    { transition: "disable", speech: "short control" },
    { transition: "enable", speech: "complete" },
    { transition: "disable", speech: "complete" },
  ])(
    "preserves capture and dispatches only complete speech across $transition with $speech",
    async ({ transition, speech }) => {
      const f = await fixture("stt-tts", false, {
        tools: { media: { audio: { maxBytes: 192_044 } } },
      });
      const complete = speech === "complete";
      const uncapturedFrames = complete ? 50 : 12;
      const openingFrames = transition === "enable" ? uncapturedFrames : 50;
      const closingFrames = transition === "enable" ? 50 : uncapturedFrames;
      const capturedMarker = transition === "enable" ? 2 : 1;
      const capturedText = speech === "short control" ? "stop that" : "Send the update";
      const texts = complete
        ? ["Opening context", "closing context"]
        : transition === "enable"
          ? ["Do not", capturedText]
          : [capturedText, "actually don't"];
      const transcribedMarkers: number[] = [];
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        const marker = wav.readUInt8(44);
        transcribedMarkers.push(marker);
        return { text: texts[marker - 1] };
      });
      const openingDecoded = createDeferred<void>();
      decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
        let decoded = 0;
        for await (const packet of input) {
          await params.onChunk(packet, packet);
          if (++decoded === openingFrames) {
            openingDecoded.resolve();
          }
        }
      });
      if (transition === "disable") {
        expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
      }
      const receiving = f.begin("100000000000000001");
      const stream = f.streams.get("100000000000000001")!;
      try {
        // Each decoded packet is 20 ms of 48 kHz stereo PCM. Change capture only
        // after the receiver has consumed the opening speech, before utterance end.
        for (let frame = 0; frame < openingFrames; frame++) {
          stream.write(Buffer.alloc(3_840, 1));
        }
        await openingDecoded.promise;
        await f.entry.processingQueue;
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
        expect(
          transition === "enable"
            ? await startTranscripts(f.manager, f.sink)
            : await stopTranscripts(),
        ).toMatchObject({ ok: true });
        for (let frame = 0; frame < closingFrames; frame++) {
          stream.write(Buffer.alloc(3_840, 2));
        }
      } finally {
        stream.end();
        await receiving;
        await f.entry.processingQueue;
      }
      expect(getSessionConnection(f.entry).receiver.subscribe).toHaveBeenCalledOnce();
      expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
      await Promise.all(f.conversations.mock.results.map((result) => result.value));
      expect(transcribedMarkers).toEqual(complete ? [1, 2] : [capturedMarker]);
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: texts[capturedMarker - 1], sessionId: "notes-1" }),
      );
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      if (complete) {
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining(texts.join("\n")),
        });
      } else {
        expect(agentCommandMock).not.toHaveBeenCalled();
        transcribeAudioFileMock.mockResolvedValue({ text: "A complete new request" });
        await f.audio("100000000000000001", 3);
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
          message: expect.stringContaining("A complete new request"),
        });
        expect(f.sink).toHaveBeenCalledTimes(transition === "enable" ? 2 : 1);
      }
    },
  );

  it("preserves one complete batch utterance when recording is not active", async () => {
    const f = await fixture("stt-tts", false, {
      tools: { media: { audio: { maxBytes: 192_044 } } },
    });
    const receiving = f.begin("100000000000000001");
    const stream = f.streams.get("100000000000000001")!;
    stream.write(Buffer.alloc(64_000, 1));
    stream.write(Buffer.alloc(64_000, 2));
    stream.end(Buffer.alloc(64_000, 3));
    await receiving;
    await f.entry.processingQueue;
    await Promise.all(f.conversations.mock.results.map((result) => result.value));
    expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
    expect(agentCommandMock).toHaveBeenCalledOnce();
    expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("audio-1-192000"),
    });
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(f.sink).not.toHaveBeenCalled();
  });

  it.each(["identity", "decoder"])("revokes opening packets while %s is pending", async (stage) => {
    const f = await fixture();
    await startTranscripts(f.manager, f.sink);
    const { promise: blocked, resolve: release } = createDeferred<void>();
    if (stage === "identity") {
      f.client.fetchMember.mockImplementation(async () => {
        await blocked;
        return { nickname: "Guest", user: { id: "guest" } };
      });
    } else {
      decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
        await blocked;
        for await (const pcm of stream) {
          await params.onChunk(pcm, pcm);
        }
      });
    }
    const receiving = f.begin("guest");
    expect(f.streams.has("guest")).toBe(true);
    f.streams.get("guest")!.end(Buffer.alloc(96_000, 3));
    await stopTranscripts();
    const replacement = vi.fn();
    await startTranscripts(f.manager, replacement, "notes-2");
    release();
    await receiving;
    await f.entry.processingQueue;
    expect(f.sink).not.toHaveBeenCalled();
    expect(replacement).not.toHaveBeenCalled();
    expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each(["start", "replace"])(
    "binds new audio during continuous speech at capture %s",
    async (phase) => {
      const f = await fixture();
      if (phase === "replace") {
        await startTranscripts(f.manager, f.sink);
      }
      const receiving = f.begin("100000000000000001");
      await vi.waitFor(() => expect(f.streams.has("100000000000000001")).toBe(true));
      const stream = f.streams.get("100000000000000001")!;
      stream.write(Buffer.alloc(96_000, 1));
      await vi.waitFor(() => expect(realtimeSessionMock.sendAudio).toHaveBeenCalled());
      const nextSink = vi.fn();
      await startTranscripts(f.manager, nextSink, "notes-2");
      stream.end(Buffer.alloc(96_000, 2));
      await receiving;
      await f.entry.processingQueue;
      expect(nextSink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "audio-2-96000" }),
      );
      expect(f.sink).not.toHaveBeenCalled();
      expect(getSessionConnection(f.entry).receiver.subscribe).toHaveBeenCalledOnce();
      expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
    },
  );

  it("starts recording a continuously speaking denied participant", async () => {
    const f = await fixture();
    await f.begin("guest");
    expect(f.streams.size).toBe(0);
    f.entry.connection.receiver.speaking.users.set("guest", Date.now());
    await startTranscripts(f.manager, f.sink);
    expect(f.streams.has("guest")).toBe(true);
    f.streams.get("guest")!.end(Buffer.alloc(96_000, 2));
    await vi.waitFor(() => expect(f.sink).toHaveBeenCalledOnce());
    expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each([3_884, 192_044])(
    "retains recording chunks under the prepared %i-byte upload cap with ingress timestamps",
    async (maxBytes) => {
      const pcmBytes = maxBytes - 44;
      resolveAudioInputBudgetMock.mockResolvedValueOnce({ enabled: true, maxBytes });
      const f = await fixture("agent-proxy", false, {
        tools: {
          media: {
            models: [
              { provider: "example", capabilities: ["image"], maxBytes: 96_044 },
              { provider: "example", capabilities: ["audio"], maxBytes },
            ],
          },
        },
      });
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin("guest");
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(1_000_000);
        f.streams.get("guest")!.write(Buffer.alloc(pcmBytes, 1));
        clock.mockReturnValue(1_010_000);
        f.streams.get("guest")!.end(Buffer.alloc(pcmBytes, 2));
        await receiving;
        await f.entry.processingQueue;
        expect(f.sink.mock.calls.map(([u]) => [Date.parse(u.startedAt), u.text])).toEqual([
          [1_000_000, `audio-1-${pcmBytes}`],
          [1_010_000, `audio-2-${pcmBytes}`],
        ]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("retains queued WAV input until processing owns its release", async () => {
    const f = await fixture();
    await startTranscripts(f.manager, f.sink);
    const { promise: blocked, resolve: release } = createDeferred<void>();
    f.entry.processingQueue = blocked;
    const removals = vi.spyOn(fs, "rm");
    vi.useFakeTimers();
    try {
      const receiving = f.begin("guest");
      f.streams.get("guest")!.end(Buffer.alloc(96_000, 3));
      await receiving;
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 1);
      await Promise.all(removals.mock.results.map((result) => result.value));
      release();
      await f.entry.processingQueue;
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "audio-3-96000" }),
      );
    } finally {
      release();
      vi.useRealTimers();
      removals.mockRestore();
    }
  });

  it.each(["missing", "disabled"])(
    "grants no passive receive access with %s capture",
    async (kind) => {
      const f = await fixture(
        "agent-proxy",
        false,
        kind === "disabled" ? { transcripts: { enabled: false } } : {},
      );
      await f.begin("guest");
      expect(f.streams.size).toBe(0);
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("flushes bounded contiguous long speech with ingress timestamps", async () => {
    const f = await fixture();
    const packetCount = 130;
    const consumed = Array.from({ length: packetCount }, () => createDeferred<void>());
    const processed = createDeferred<void>();
    decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
      let decodedPackets = 0;
      try {
        for await (const packet of input) {
          await params.onChunk(packet, packet);
          consumed[decodedPackets]!.resolve();
          decodedPackets += 1;
          if (decodedPackets === packetCount) {
            processed.resolve();
          }
        }
        if (decodedPackets < packetCount) {
          processed.reject(new Error("Voice input ended before all test packets were processed"));
        }
      } catch (error) {
        processed.reject(error);
        params.onError?.(error);
      }
    });
    await startTranscripts(f.manager, f.sink);
    const startedBefore = Date.now();
    const receiving = f.begin("guest");
    await vi.waitFor(() => expect(f.streams.has("guest")).toBe(true));
    const stream = f.streams.get("guest")!;
    const frame = Buffer.alloc(192_000, 7);
    try {
      const clock = vi.spyOn(Date, "now");
      try {
        for (let second = 0; second < packetCount; second++) {
          clock.mockReturnValue(startedBefore + second * 1_000);
          stream.write(frame);
          await consumed[second]!.promise;
        }
      } finally {
        clock.mockRestore();
      }
      // Observe the real WAV write/queue work, not a one-second disk deadline.
      await processed.promise;
      await f.entry.processingQueue;
      expect(transcribeAudioFileMock).toHaveBeenCalled();
    } finally {
      stream.end();
      await receiving;
      await f.entry.processingQueue;
    }
    const utterances = f.sink.mock.calls.map(([u]) => u);
    expect(utterances.length).toBeGreaterThan(1);
    expect(utterances.every((u) => u.speaker.id === "guest")).toBe(true);
    expect(utterances.reduce((bytes, u) => bytes + Number(u.text.split("-")[2]), 0)).toBe(
      packetCount * frame.length,
    );
    expect(Date.parse(utterances[0].startedAt)).toBeGreaterThanOrEqual(startedBefore);
    expect(
      Date.parse(utterances.at(-1).startedAt) - Date.parse(utterances[0].startedAt),
    ).toBeGreaterThan(60_000);
  });

  it.each(["queue", "stt"])(
    "revokes captured audio during %s without redirecting it to a replacement",
    async (stage) => {
      const f = await fixture();
      await startTranscripts(f.manager, f.sink);
      const { promise: blocked, resolve: release } = createDeferred<void>();
      if (stage === "queue") {
        f.entry.processingQueue = blocked;
      } else {
        transcribeAudioFileMock.mockImplementationOnce(async () => {
          await blocked;
          return { text: "stale recording" };
        });
      }
      const receiving = f.begin("guest");
      await vi.waitFor(() => expect(f.streams.has("guest")).toBe(true));
      f.streams.get("guest")!.end(Buffer.alloc(96_000));
      await receiving;
      if (stage === "stt") {
        await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledOnce());
      }
      await stopTranscripts();
      const replacement = vi.fn();
      await startTranscripts(f.manager, replacement, "notes-2");
      release();
      await f.entry.processingQueue;
      expect(f.sink).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
    },
  );

  it("keeps already-received final audio across occupancy departure and rejects stale bytes", async () => {
    const f = await fixture("agent-proxy", true);
    await startTranscripts(f.manager, f.sink);
    const { promise: decoderReady, resolve: releaseDecoder } = createDeferred<void>();
    decodeOpusStreamChunksMock.mockImplementation(async (stream, params) => {
      await decoderReady;
      for await (const pcm of stream) {
        await params.onChunk(pcm, pcm);
      }
    });
    const receiving = f.begin("guest");
    expect(f.streams.has("guest")).toBe(true);
    f.streams.get("guest")!.write(Buffer.alloc(96_000, 4));
    await vi.waitFor(() => expect(f.streams.get("guest")!.readableLength).toBe(0));
    f.states.length = 0;
    await updateVoiceState(f.manager, "100000000000000001", null);
    f.streams.get("guest")!.emit("data", Buffer.alloc(96_000, 9));
    releaseDecoder();
    await receiving;
    await f.entry.processingQueue;
    expect(f.sink).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: { id: "guest", label: "Guest" },
        text: "audio-4-96000",
      }),
    );
    await f.begin("stale-speaker");
    expect(f.streams.has("stale-speaker")).toBe(false);
    expect(agentCommandMock).not.toHaveBeenCalled();
  });
});
