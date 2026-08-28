import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    createAudioPlayerMock,
    createClientWithMember,
    createManager,
    entersStateMock,
    getSessionEntry,
    getVoiceReceive,
    lastTtsStreamArgs,
    loggerWarnMock,
    makeVoiceConfig,
    processVoiceSegment,
    transcribeAudioFileMock,
    decodeOpusStreamMock,
    textToSpeechMock,
    textToSpeechStreamMock,
  }) => {
    it.each(["transcribing", "queued"] as const)(
      "drops retired transcript audio while %s",
      async (phase) => {
        const client = createClientWithMember("u-guest", "Guest", "4321");
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
          client,
        );
        const first = vi.fn();
        const second = vi.fn();
        const onStop = vi.fn();
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          { transcripts: { sessionId: "old", onUtterance: first, onStop } },
        );
        const entry = getSessionEntry(manager);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let processing: Promise<void>;
        if (phase === "transcribing") {
          transcribeAudioFileMock.mockImplementationOnce(async () => {
            entered();
            await gate;
            return { text: "retired" };
          });
          processing = getVoiceReceive(manager).processSegment({
            entry,
            wavPath: "/tmp/test.wav",
            userId: "u-guest",
            durationSeconds: 1,
          });
          await started;
        } else {
          entry.processingQueue = gate;
          decodeOpusStreamMock.mockResolvedValueOnce(Buffer.alloc(192_000));
          await getVoiceReceive(manager).handleSpeakingStart(entry, "u-guest");
          processing = entry.processingQueue;
        }
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          { transcripts: { sessionId: "new", onUtterance: second } },
        );
        release();
        await processing;
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        expect(onStop).toHaveBeenCalledOnce();
        await getVoiceReceive(manager).processSegment({
          entry,
          wavPath: "/tmp/test.wav",
          userId: "u-guest",
          durationSeconds: 1,
        });
        expect(second).toHaveBeenCalledOnce();
        await manager.destroy();
      },
    );

    it("keeps streaming TTS audio alive until Discord finishes playback without a duration deadline", async () => {
      const release = vi.fn(async () => undefined);
      let finishPlayback!: () => void;
      const playbackCompletion = new Promise<void>((resolve) => {
        finishPlayback = resolve;
      });
      entersStateMock.mockImplementation(async (_target, state, timeoutOrSignal) => {
        if (state !== "idle") {
          return;
        }
        if (typeof timeoutOrSignal === "number") {
          throw new Error("voice playback deadline elapsed");
        }
        await playbackCompletion;
      });
      textToSpeechStreamMock.mockResolvedValue({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        release,
      });
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "hello back" }],
      });

      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        { groupPolicy: "open", allowFrom: ["discord:u-guest"] },
        client,
        {},
      );
      await processVoiceSegment(manager, "u-guest");

      expect(lastTtsStreamArgs().channel).toBe("discord");
      expect(lastTtsStreamArgs().disableFallback).toBe(true);
      expect(lastTtsStreamArgs().text).toBe("hello back");
      expect(textToSpeechMock).not.toHaveBeenCalled();
      const player = createAudioPlayerMock.mock.results.at(-1)?.value;
      await vi.waitFor(() =>
        expect(entersStateMock).toHaveBeenCalledWith(player, "idle", expect.any(AbortSignal)),
      );
      expect(release).not.toHaveBeenCalled();
      finishPlayback();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it("releases and reports streaming TTS that ends before playback starts", async () => {
      const release = vi.fn(async () => undefined);
      textToSpeechStreamMock.mockResolvedValueOnce({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        release,
      });
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "failed voice reply" }] });
      entersStateMock.mockImplementation(async (target, state, signal) => {
        if (state === "playing") {
          if (!(signal instanceof AbortSignal)) {
            throw new Error("Expected a cancellable playback wait");
          }
          const lifecycle = signal;
          const readinessFailure = new Promise<never>((_resolve, reject) => {
            lifecycle.addEventListener("abort", () => reject(new Error("player never started")), {
              once: true,
            });
          });
          const player = target as ReturnType<typeof createAudioPlayerMock>;
          const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1];
          idleHandler?.();
          await readinessFailure;
        }
      });
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        { groupPolicy: "open", allowFrom: ["discord:u-guest"] },
        client,
      );

      await processVoiceSegment(manager, "u-guest");

      await vi.waitFor(() =>
        expect(loggerWarnMock).toHaveBeenCalledWith(
          "discord voice: playback failed: player never started",
        ),
      );
      expect(release).toHaveBeenCalledOnce();
      expect(entersStateMock).not.toHaveBeenCalledWith(
        expect.anything(),
        "idle",
        expect.anything(),
      );
    });

    it.each([
      { name: "buffering before playback starts", buffering: true },
      { name: "actively playing", buffering: false },
    ])(
      "releases $name streaming TTS immediately when the session leaves",
      async ({ buffering }) => {
        const release = vi.fn(async () => undefined);
        textToSpeechStreamMock.mockResolvedValueOnce({
          success: true,
          audioStream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
          }),
          release,
        });
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "unfinished voice reply" }] });
        const client = createClientWithMember("u-guest", "Guest", "4321");
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
          client,
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        entersStateMock.mockImplementation(async (_target, state, signal) => {
          if (state === (buffering ? "playing" : "idle")) {
            await new Promise<void>((_resolve, reject) => {
              if (!(signal instanceof AbortSignal)) {
                throw new Error("Expected a cancellable playback wait");
              }
              const lifecycle = signal;
              lifecycle.addEventListener("abort", () => reject(new Error("playback cancelled")), {
                once: true,
              });
            });
          }
        });
        entry.player.stop.mockImplementation(() => {
          const idleHandler = entry.player.on.mock.calls.find(([event]) => event === "idle")?.[1];
          idleHandler?.();
          return true;
        });

        await getVoiceReceive(manager).processSegment({
          entry,
          wavPath: "/tmp/test.wav",
          userId: "u-guest",
          durationSeconds: 1.2,
        });
        await vi.waitFor(() =>
          expect(entersStateMock).toHaveBeenCalledWith(
            entry.player,
            buffering ? "playing" : "idle",
            expect.any(AbortSignal),
          ),
        );
        expect(release).not.toHaveBeenCalled();

        expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);
        await entry.playbackQueue;

        expect(entry.player.stop).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(loggerWarnMock).not.toHaveBeenCalledWith(
          expect.stringContaining("discord voice: playback failed"),
        );
      },
    );
  },
);
