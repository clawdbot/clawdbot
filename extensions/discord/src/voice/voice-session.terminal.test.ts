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
    startTranscripts,
    getVoiceReceive,
    getLastAudioPlayer,
    loggerErrorMock,
    lastRealtimeBridgeParams,
    lastRealtimeBridge,
    beginSpeakerTurn,
    expectOffEventWithFunction,
    createJoinedAgentProxyFixture,
    handleSpeakingStart,
  }) => {
    it.each([
      ["agent-proxy", "leave"],
      ["agent-proxy", "destroyed"],
      ["bidi", "leave"],
      ["bidi", "destroyed"],
    ] as const)(
      "retires %s room capture on %s without affecting its replacement",
      async (mode, boundary) => {
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
          const onUtterance = vi.fn();
          await startTranscripts(manager, onUtterance);
          const registration = entry.transcripts;
          decodeOpusStreamChunksMock.mockReturnValueOnce(decoding.promise);
          receive = handleSpeakingStart(manager, entry, "u-owner");
          await vi.waitFor(() => expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce());
          const captureStream = expectDefined(
            oldConnection.receiver.subscribe.mock.results[0]?.value,
            "voice capture stream",
          );
          getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-owner", "speaker end");
          expect(entry.capture.get("u-owner")?.finalizeTimer).toBeDefined();
          const turn = beginSpeakerTurn(entry);
          const { bridgeParams: provider, session: oldProvider } = lastRealtimeBridge();
          const player = getLastAudioPlayer();
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          expect(player.play).toHaveBeenCalledOnce();

          if (boundary === "leave") {
            await manager.leave({ guildId: "g1" });
          } else {
            oldConnection.state.status = "destroyed";
            expectDefined(oldConnection.handlers.get("destroyed"), "destroyed listener")();
          }

          expect(manager.status()).toEqual([]);
          expect(entry.realtimeLifecycle.status).toBe("stopped");
          expect(entry.transcripts).toBe(registration);
          expect(registration?.isCurrent()).toBe(true);
          expect(captureStream.destroy).toHaveBeenCalledOnce();
          expect(entry.capture.size).toBe(0);
          expect(oldConnection.destroy).toHaveBeenCalledTimes(boundary === "leave" ? 1 : 0);
          expect(oldProvider.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).not.toHaveBeenCalled();
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
          expect(replacement.transcripts).toBe(registration);
          const replacementProvider = lastRealtimeBridge();
          const inputCalls = oldProvider.sendAudio.mock.calls.length;
          turn.sendInputAudio(Buffer.alloc(3840));
          turn.close();
          provider.onClose?.("error");
          provider.onReady?.();
          provider.onEvent?.({ direction: "client", type: "session.reconnect.ready" });
          provider.audioSink.sendAudio(Buffer.alloc(24_000));
          provider.onTranscript?.("user", "stale transcript", true);
          provider.onEvent?.({ direction: "server", type: "response.done" });
          await Promise.resolve();

          expectConnectedStatus(manager, "1001");
          expect(getSessionEntry(manager)).toBe(replacement);
          expect(newConnection.destroy).not.toHaveBeenCalled();
          expect(oldProvider.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).not.toHaveBeenCalled();
          expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
          expect(player.play).toHaveBeenCalledOnce();
          expect(registration?.isCurrent()).toBe(true);
          expect(onUtterance).not.toHaveBeenCalled();
          beginSpeakerTurn(replacement);
          expect(replacementProvider.session.sendAudio).toHaveBeenCalledOnce();
          expect(oldProvider.sendAudio).toHaveBeenCalledTimes(inputCalls);
        } finally {
          decoding.resolve();
          await receive;
          await manager.destroy();
        }
      },
    );

    it.each([
      ["agent-proxy", "completed"],
      ["agent-proxy", "error"],
      ["bidi", "completed"],
      ["bidi", "error"],
    ] as const)(
      "retires an unbound %s room when its warm provider closes with %s",
      async (mode, reason) => {
        const manager = createAgentProxyManager(undefined, { voice: { mode } });
        try {
          await manager.join({ guildId: "g1", channelId: "1001" });
          const entry = getSessionEntry(manager);
          const provider = lastRealtimeBridgeParams();
          const destroyConnection = vi.spyOn(entry.connection, "destroy");
          provider.onClose?.(reason);
          expect(manager.status()).toEqual([]);
          expect(entry.realtimeLifecycle.status).toBe("stopped");
          expect(destroyConnection).toHaveBeenCalledOnce();
          expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
          expect(loggerErrorMock).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(`Realtime provider closed unexpectedly: ${reason}`),
          );
        } finally {
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
