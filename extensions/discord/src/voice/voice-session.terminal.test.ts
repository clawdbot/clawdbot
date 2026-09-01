import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expectDefined,
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    createAudioPlayerMock,
    realtimeSessionMock,
    decodeOpusStreamChunksMock,
    createAgentProxyManager,
    expectConnectedStatus,
    getSessionEntry,
    getVoiceReceive,
    getLastAudioPlayer,
    loggerErrorMock,
    lastRealtimeBridgeParams,
    beginSpeakerTurn,
    expectOffEventWithFunction,
    createJoinedAgentProxyFixture,
    handleSpeakingStart,
  }) => {
    it.each([
      ["agent-proxy", "completed"],
      ["agent-proxy", "error"],
      ["bidi", "completed"],
      ["bidi", "error"],
    ] as const)(
      "retires %s voice on provider %s without affecting its replacement",
      async (mode, reason) => {
        const oldConnection = createConnectionMock();
        const newConnection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
        const manager = createAgentProxyManager(undefined, {
          allowFrom: ["discord:u-owner"],
          voice: { mode },
        });
        const decoding = createDeferred<void>();
        let receive: Promise<void> | undefined;
        try {
          await manager.join({ guildId: "g1", channelId: "1001" });
          const entry = getSessionEntry(manager);
          const onStop = vi.fn();
          const transcripts = {
            sessionId: "notes-1",
            onUtterance: vi.fn(),
            onStop: () => {
              onStop(entry.transcripts);
              entry.stop();
            },
          };
          await manager.join({ guildId: "g1", channelId: "1001" }, { transcripts });
          decodeOpusStreamChunksMock.mockReturnValueOnce(decoding.promise);
          receive = handleSpeakingStart(manager, entry, "u-owner");
          await vi.waitFor(() => expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce());
          const captureStream = expectDefined(
            oldConnection.receiver.subscribe.mock.results[0]?.value,
            "voice capture stream",
          );
          getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-owner", "speaker end");
          expect(entry.capture.captureFinalizeTimers.size).toBe(1);
          const turn = beginSpeakerTurn(entry);
          const provider = lastRealtimeBridgeParams();
          const player = getLastAudioPlayer();
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          expect(player.play).toHaveBeenCalledOnce();

          provider.onClose?.(reason);

          expect(manager.status()).toEqual([]);
          expect(entry.realtimeLifecycle.status).toBe("stopped");
          expect(entry.transcripts).toBeUndefined();
          expect(onStop).toHaveBeenCalledExactlyOnceWith(undefined);
          expect(captureStream.destroy).toHaveBeenCalledOnce();
          expect(entry.capture.activeCaptureStreams.size).toBe(0);
          expect(entry.capture.captureFinalizeTimers.size).toBe(0);
          expect(oldConnection.destroy).toHaveBeenCalledOnce();
          expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(`Realtime provider closed unexpectedly: ${reason}`),
          );
          expect(player.stop).toHaveBeenCalledWith(true);
          expectOffEventWithFunction(oldConnection.receiver.speaking.off, "start");
          expectOffEventWithFunction(oldConnection.receiver.speaking.off, "end");
          const audioPlayer = expectDefined(
            createAudioPlayerMock.mock.results[0]?.value,
            "audio player",
          );
          expectOffEventWithFunction(audioPlayer.off, "idle");

          await manager.join({ guildId: "g1", channelId: "1001" });
          const replacement = getSessionEntry(manager);
          const replacementTranscripts = {
            sessionId: "notes-2",
            onUtterance: vi.fn(),
            onStop: vi.fn(),
          };
          await manager.join(
            { guildId: "g1", channelId: "1001" },
            { transcripts: replacementTranscripts },
          );
          const inputCalls = realtimeSessionMock.sendAudio.mock.calls.length;
          turn.sendInputAudio(Buffer.alloc(3840));
          turn.close();
          provider.onClose?.(reason);
          provider.onReady?.();
          provider.onEvent?.({ direction: "client", type: "session.reconnect.ready" });
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          provider.onTranscript?.("user", "stale transcript", true);
          provider.onEvent?.({ direction: "server", type: "response.done" });
          await Promise.resolve();

          expectConnectedStatus(manager, "1001");
          expect(getSessionEntry(manager)).toBe(replacement);
          expect(newConnection.destroy).not.toHaveBeenCalled();
          expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).toHaveBeenCalledOnce();
          expect(realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(inputCalls);
          expect(player.play).toHaveBeenCalledOnce();
          expect(onStop).toHaveBeenCalledOnce();
          expect(replacementTranscripts.onStop).not.toHaveBeenCalled();
          expect(transcripts.onUtterance).not.toHaveBeenCalled();
          expect(replacementTranscripts.onUtterance).not.toHaveBeenCalled();
          beginSpeakerTurn(replacement);
          expect(realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(inputCalls + 1);
        } finally {
          decoding.resolve();
          await receive;
          await manager.destroy();
        }
      },
    );

    it("does not report a terminal error when local close synchronously closes the provider", async () => {
      const { bridgeParams, manager } = await createJoinedAgentProxyFixture();
      realtimeSessionMock.close.mockImplementationOnce(() => bridgeParams.onClose?.("completed"));
      try {
        await manager.leave({ guildId: "g1" });
        expect(manager.status()).toEqual([]);
        expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
        expect(loggerErrorMock).not.toHaveBeenCalled();
      } finally {
        await manager.destroy();
      }
    });
  },
);
