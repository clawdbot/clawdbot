import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    createConnectionMock,
    joinVoiceChannelMock,
    realtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    createAgentProxyManager,
    getLastAudioPlayer,
    lastRealtimeBridgeParams,
  }) => {
    it("releases an initial voice session when provider connect fails", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      realtimeSessionMock.connect.mockRejectedValueOnce(new Error("provider unavailable"));
      const manager = createAgentProxyManager();

      try {
        await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
          ok: false,
          message: "Failed to start Discord realtime voice: provider unavailable",
          guildId: "g1",
          channelId: "1001",
        });

        expect(manager.status()).toEqual([]);
        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
        expect(realtimeSessionMock.close).toHaveBeenCalled();
      } finally {
        await manager.destroy();
      }
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    });

    it("releases initial startup when the manager is destroyed during provider connect", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createAgentProxyManager();
      realtimeSessionMock.connect.mockImplementationOnce(async () => {
        await manager.destroy();
      });

      try {
        await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
          guildId: "g1",
          channelId: "1001",
        });

        expect(manager.status()).toEqual([]);
        expect(realtimeSessionMock.close).toHaveBeenCalled();
        expect(connection.destroy).toHaveBeenCalledTimes(1);
        expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
      } finally {
        await manager.destroy();
      }
    });

    it("does not activate capture if Discord destroys the connection during initial startup", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createAgentProxyManager();
      realtimeSessionMock.connect.mockImplementationOnce(async () => {
        connection.state.status = "destroyed";
        connection.handlers.get("destroyed")?.();
      });

      try {
        await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
          guildId: "g1",
          channelId: "1001",
        });

        expect(manager.status()).toEqual([]);
        expect(connection.receiver.speaking.on).not.toHaveBeenCalled();
        expect(realtimeSessionMock.close).toHaveBeenCalled();
        expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
      } finally {
        await manager.destroy();
      }
      expect(connection.destroy).not.toHaveBeenCalled();
    });

    it.each(["output overflow", "completed", "error", "synchronous close"] as const)(
      "handles terminal provider %s before the initial realtime connect finishes",
      async (terminal) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createAgentProxyManager();
        if (terminal === "synchronous close") {
          createRealtimeVoiceBridgeSessionMock.mockImplementationOnce(() => {
            lastRealtimeBridgeParams().onClose?.("error");
            return realtimeSessionMock;
          });
        } else {
          realtimeSessionMock.connect.mockImplementationOnce(async () => {
            const provider = lastRealtimeBridgeParams();
            if (terminal === "output overflow") {
              // Provider output can arrive while connect is pending; exceed the two-minute PCM cap.
              provider.audioSink.sendAudio(Buffer.alloc(24_000 * 2 * 121));
            } else {
              provider.onClose?.(terminal);
            }
          });
        }

        try {
          await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual({
            ok: false,
            message: "Discord realtime voice session stopped before startup completed.",
            guildId: "g1",
            channelId: "1001",
          });

          expect(manager.status()).toEqual([]);
          expect(connection.receiver.speaking.on).not.toHaveBeenCalled();
          expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
          expect(connection.destroy).toHaveBeenCalledTimes(1);
          expect(getLastAudioPlayer().stop).toHaveBeenCalledWith(true);
          if (terminal === "synchronous close") {
            expect(realtimeSessionMock.connect).not.toHaveBeenCalled();
          }
        } finally {
          await manager.destroy();
        }
        expect(connection.destroy).toHaveBeenCalledTimes(1);
      },
    );
  },
);
