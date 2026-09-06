import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { SpeakingMap } from "@discordjs/voice";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    expectDefined,
    it,
    vi,
    createClient,
    createManager,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    realtimeSessionMock,
    createRealtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    realtimeBridgeAt,
    configureVoiceStateGateway,
    getSessionEntry,
    getLastAudioPlayer,
    startTranscripts,
    stopTranscripts,
    emitDecryptFailure,
    decodeOpusStreamChunksMock,
    transcribeAudioFileMock,
    agentCommandMock,
    controlRealtimeVoiceAgentRunMock,
    enqueueSystemEventMock,
  }) => {
    const sentAudioCount = () =>
      createRealtimeVoiceBridgeSessionMock.mock.calls.reduce(
        (count, _call, index) =>
          count + realtimeBridgeAt(index).session.sendAudio.mock.calls.length,
        0,
      );

    function fixture(
      occupied: boolean,
      mode: "agent-proxy" | "bidi" | "stt-tts" = "agent-proxy",
      participant = "guest",
    ) {
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Guest",
        roles: [],
        user: { id: participant },
      });
      const states = [
        {
          user_id: participant,
          channel_id: "1001",
          member: { user: { id: participant, bot: false } },
        },
      ];
      configureVoiceStateGateway(client, () => states);
      const manager = createManager(
        {
          groupPolicy: "open",
          allowFrom: ["discord:owner"],
          voice: {
            enabled: true,
            mode,
            realtime: { provider: "openai", requireWakeName: true, bargeIn: false },
            ...(occupied
              ? { autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }] }
              : {}),
          },
        },
        client,
      );
      const connection = createConnectionMock();
      const speaking = new SpeakingMap();
      connection.receiver.speaking = {
        users: speaking.users,
        on: vi.fn(speaking.on.bind(speaking)),
        off: vi.fn(speaking.off.bind(speaking)),
      };
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValue(stream);
      decodeOpusStreamChunksMock.mockImplementation(async (input, params) => {
        for await (const packet of input) {
          await params.onChunk(packet, packet);
        }
      });
      transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
        const wav = await fs.readFile(filePath);
        return { text: `${wav.toString("ascii", 0, 4)}-${wav[44]}-${wav.length - 44}` };
      });
      const received = createDeferred<void>();
      const sink = vi.fn(() => received.resolve());
      return { manager, connection, speaking, stream, states, received, sink };
    }

    it.each([
      { name: "capture-only", occupied: false, recovery: false, stage: "ready", overlap: "none" },
      {
        name: "occupied autoJoin bootstrap",
        occupied: true,
        recovery: false,
        stage: "bootstrap",
        overlap: "none",
      },
      {
        name: "occupied autoJoin connect",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "none",
      },
      {
        name: "capture-only recovery",
        occupied: false,
        recovery: true,
        stage: "ready",
        overlap: "none",
      },
      {
        name: "occupied recovery",
        occupied: true,
        recovery: true,
        stage: "connect",
        overlap: "none",
      },
      {
        name: "overlapping start event",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "after",
      },
      {
        name: "start event before scan",
        occupied: true,
        recovery: false,
        stage: "connect",
        overlap: "before",
      },
    ])(
      "records speech already in progress at $name readiness",
      async ({ occupied, recovery, stage, overlap }) => {
        const f = fixture(occupied);
        if (recovery) {
          expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
        }
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        const waiting = createDeferred<void>();
        const ready = createDeferred<undefined>();
        const provider = recovery ? createRealtimeSessionMock() : realtimeSessionMock;
        if (recovery) {
          createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(provider);
        }
        const pending =
          stage === "ready"
            ? entersStateMock
            : stage === "bootstrap"
              ? resolveRealtimeBootstrapContextInstructionsMock
              : provider.connect;
        pending.mockImplementationOnce(() => {
          waiting.resolve();
          return ready.promise;
        });
        const joins = vi.spyOn(f.manager, "join");
        const starting = recovery ? undefined : startTranscripts(f.manager, f.sink);
        if (recovery) {
          emitDecryptFailure(f.manager);
          emitDecryptFailure(f.manager);
          emitDecryptFailure(f.manager);
        }
        const starts = vi.fn();
        f.speaking.on("start", starts);
        try {
          await vi.waitFor(() => expect(joins).toHaveBeenCalledOnce());
          await Promise.race([
            waiting.promise,
            Promise.resolve(joins.mock.results[0]!.value).then((result) => {
              throw new Error(`Voice join completed before its readiness gate: ${result.message}`);
            }),
          ]);
          vi.useFakeTimers();
          // Native speaking state exists before OpenClaw installs its receive listeners.
          f.speaking.onPacket("guest");
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          if (overlap === "before") {
            // Roster publication follows listener installation and session-map publication.
            enqueueSystemEventMock.mockImplementationOnce(() => {
              f.speaking.emit("start", "guest");
              return true;
            });
          }
          ready.resolve(undefined);
          expect(await joins.mock.results[0]!.value).toMatchObject({ ok: true });
          if (starting) {
            expect(await starting).toMatchObject({ ok: true });
          }
          expect(f.connection.receiver.subscribe).toHaveBeenCalledExactlyOnceWith(
            "guest",
            expect.anything(),
          );
          // Continuous packets refresh the native timeout without another start event.
          f.speaking.onPacket("guest");
          expect(starts).toHaveBeenCalledTimes(overlap === "before" ? 2 : 1);
          if (overlap === "after") {
            f.speaking.emit("start", "guest");
          }
          f.stream.end(Buffer.alloc(96_000, 7));
          await f.received.promise;
          await getSessionEntry(f.manager).processingQueue;
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              sessionId: "notes-1",
              speaker: { id: "guest", label: "Guest" },
              text: "RIFF-7-96000",
            }),
          );
          expect(f.connection.receiver.subscribe).toHaveBeenCalledOnce();
          expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
          expect(transcribeAudioFileMock).toHaveBeenCalledOnce();
          expect(sentAudioCount()).toBe(0);
          expect(agentCommandMock).not.toHaveBeenCalled();
          expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
          expect(getLastAudioPlayer().play).not.toHaveBeenCalled();
        } finally {
          ready.resolve(undefined);
          await f.manager.destroy();
          f.stream.destroy();
          vi.clearAllTimers();
          vi.useRealTimers();
          joins.mockRestore();
        }
      },
    );

    it.each([
      { mode: "stt-tts", origin: "readiness" },
      { mode: "agent-proxy", origin: "readiness" },
      { mode: "stt-tts", origin: "playback" },
      { mode: "bidi", origin: "playback" },
      { mode: "stt-tts", origin: "recovery" },
      { mode: "bidi", origin: "recovery" },
      { mode: "stt-tts", origin: "native" },
      { mode: "agent-proxy", origin: "native" },
    ] as const)(
      "keeps $origin speech authority through scanning and grace in $mode",
      async ({ mode, origin }) => {
        const f = fixture(true, mode, "owner");
        const subscribed = createDeferred<void>();
        f.connection.receiver.subscribe.mockImplementationOnce(() => {
          subscribed.resolve();
          return f.stream;
        });
        const writeSpeech = (stream: PassThrough, marker: number) => {
          for (let frame = 0; frame < 25; frame++) {
            stream.write(Buffer.alloc(3_840, marker));
          }
        };
        transcribeAudioFileMock.mockImplementation(async ({ filePath }) => {
          const wav = await fs.readFile(filePath);
          return {
            text:
              wav.readUInt8(44) === 1
                ? "Do not"
                : origin === "playback"
                  ? "stop that"
                  : "send the update",
          };
        });
        vi.useFakeTimers();
        try {
          if (origin === "recovery") {
            expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
          }
          joinVoiceChannelMock.mockReturnValueOnce(f.connection);
          if (origin === "playback" || origin === "native") {
            expect(await f.manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
              ok: true,
            });
            if (origin === "playback") {
              getLastAudioPlayer().state.status = "playing";
            }
          }
          // Native speaking state knows about packets that had no subscriber yet.
          f.speaking.onPacket("owner");
          if (origin === "native") {
            await subscribed.promise;
            writeSpeech(f.stream, 1);
          } else {
            expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          }
          if (origin === "playback") {
            getLastAudioPlayer().state.status = "idle";
          }
          if (origin === "recovery") {
            emitDecryptFailure(f.manager);
            emitDecryptFailure(f.manager);
            emitDecryptFailure(f.manager);
          } else {
            expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
          }
          await subscribed.promise;
          const entry = getSessionEntry(f.manager);
          const conversations = vi.spyOn(entry.conversations, "enqueue");
          writeSpeech(f.stream, 2);
          // A native restart inside OpenClaw's grace retains this same owned receive stream.
          await vi.advanceTimersByTimeAsync(SpeakingMap.DELAY + 400);
          f.speaking.onPacket("owner");
          writeSpeech(f.stream, 3);
          expect(f.connection.receiver.subscribe).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(SpeakingMap.DELAY + 2_000);
          await f.received.promise;
          await entry.processingQueue;
          await Promise.all(conversations.mock.results.map((result) => result.value));
          expect(f.stream.destroyed).toBe(true);
          expect(f.sink).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              sessionId: "notes-1",
              text: origin === "playback" ? "stop that" : "send the update",
            }),
          );
          if (origin === "native" && mode === "stt-tts") {
            expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledExactlyOnceWith({
              sessionKey: expectDefined(entry.route?.sessionKey, "voice session route"),
              text: "Do not\nsend the update",
            });
            expect(agentCommandMock).toHaveBeenCalledOnce();
            expect(agentCommandMock.mock.calls[0]?.[0]).toMatchObject({
              message: expect.stringContaining("Do not\nsend the update"),
            });
          } else {
            expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
            expect(agentCommandMock).not.toHaveBeenCalled();
          }
          if (origin === "native" && mode !== "stt-tts") {
            expect(sentAudioCount()).toBeGreaterThan(0);
          } else {
            expect(sentAudioCount()).toBe(0);
          }
          const audioCalls = sentAudioCount();
          const nextNote = createDeferred<void>();
          const nextSubscribed = createDeferred<void>();
          const nextStream = new PassThrough({ objectMode: true });
          f.connection.receiver.subscribe.mockImplementationOnce(() => {
            nextSubscribed.resolve();
            return nextStream;
          });
          f.sink.mockImplementationOnce(() => nextNote.resolve());
          transcribeAudioFileMock.mockResolvedValue({ text: "A complete new request" });
          f.speaking.onPacket("owner");
          await nextSubscribed.promise;
          writeSpeech(nextStream, 4);
          nextStream.end();
          await nextNote.promise;
          await entry.processingQueue;
          await Promise.all(conversations.mock.results.map((result) => result.value));
          expect(f.connection.receiver.subscribe).toHaveBeenCalledTimes(2);
          expect(decodeOpusStreamChunksMock).toHaveBeenCalledTimes(2);
          expect(transcribeAudioFileMock).toHaveBeenCalledTimes(
            origin === "native" && mode === "stt-tts" ? 3 : 2,
          );
          expect(f.sink).toHaveBeenCalledTimes(2);
          if (mode === "stt-tts") {
            expect(agentCommandMock).toHaveBeenCalledTimes(origin === "native" ? 2 : 1);
          } else {
            expect(sentAudioCount()).toBeGreaterThan(audioCalls);
          }
        } finally {
          await f.manager.destroy();
          f.stream.destroy();
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      },
    );

    it.each(["agent-proxy", "bidi", "stt-tts"] as const)(
      "does not start receiving existing speech on %s join without capture",
      async (mode) => {
        const f = fixture(false, mode);
        f.speaking.users.set("owner", Date.now());
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        try {
          expect(await f.manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
            ok: true,
          });
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          await f.manager.destroy();
          f.stream.destroy();
        }
      },
    );

    it.each(["cancelled", "failed", "emptied"])(
      "does not subscribe existing speech after capture join is %s",
      async (outcome) => {
        const f = fixture(outcome !== "cancelled");
        f.speaking.users.set("guest", Date.now());
        joinVoiceChannelMock.mockReturnValueOnce(f.connection);
        const waiting = createDeferred<void>();
        const ready = createDeferred<undefined>();
        entersStateMock.mockImplementationOnce(() => {
          waiting.resolve();
          return ready.promise;
        });
        const starting = startTranscripts(f.manager, f.sink);
        await waiting.promise;
        try {
          if (outcome === "cancelled") {
            expect(await stopTranscripts()).toMatchObject({ ok: true });
          } else if (outcome === "failed") {
            realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));
          } else {
            f.states.length = 0;
          }
          ready.resolve(undefined);
          expect(await starting).toMatchObject({ ok: outcome === "emptied" });
          expect(f.manager.status()).toEqual([]);
          expect(f.connection.destroy).toHaveBeenCalledOnce();
          expect(f.connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(transcribeAudioFileMock).not.toHaveBeenCalled();
          expect(f.sink).not.toHaveBeenCalled();
        } finally {
          ready.resolve(undefined);
          await f.manager.destroy();
          f.stream.destroy();
        }
      },
    );
  },
);
