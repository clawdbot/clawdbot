import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DiscordError } from "../internal/discord.js";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expectDefined,
    expect,
    it,
    vi,
    ChannelType,
    requireRecord,
    mockCall,
    lastMockCall,
    createConnectionMock,
    getVoiceConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    realtimeSessionMock,
    managerModule,
    createClient,
    createManager,
    expectConnectedStatus,
    getSessionEntry,
    beginSpeakerTurn,
    getLastAudioPlayer,
    expectOffEventWithFunction,
    createJoinedAgentProxyFixture,
    createJoinedBidiFixture,
    handleSpeakingStart,
  }) => {
    it("rejects joins when Discord voice config is absent", async () => {
      const manager = createManager({});

      const result = await manager.join({ guildId: "g1", channelId: "1001" });
      expect(result.ok).toBe(false);
      expect(result.message).toBe("Discord voice is disabled (channels.discord.voice.enabled).");

      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });

    it.each(["agent-proxy", "bidi"] as const)(
      "keeps %s playback alive through brief provider stalls",
      async (mode) => {
        const manager = createManager({
          voice: { enabled: true, mode, realtime: { provider: "openai" } },
        });

        await manager.join({ guildId: "g1", channelId: "1001" });

        expect(createAudioPlayerMock).toHaveBeenCalledWith({
          behaviors: { maxMissedFrames: 100 },
        });
      },
    );

    it("preserves default audio-player behavior for STT/TTS playback", async () => {
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      expect(createAudioPlayerMock).toHaveBeenCalledWith();
    });

    it("keeps the new session when an old disconnected handler fires", async () => {
      const oldConnection = createConnectionMock();
      const newConnection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);
      entersStateMock.mockImplementation(async (target: unknown, status?: string) => {
        if (target === oldConnection && (status === "signalling" || status === "connecting")) {
          throw new Error("old disconnected");
        }
        return undefined;
      });

      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g1", channelId: "1002" });

      const oldDisconnected = oldConnection.handlers.get("disconnected");
      expect(oldDisconnected).toBeTypeOf("function");
      await oldDisconnected?.();

      expectConnectedStatus(manager, "1002");
      await manager.destroy();
    });

    it("keeps the new session when an old destroyed handler fires", async () => {
      const oldConnection = createConnectionMock();
      const newConnection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(oldConnection).mockReturnValueOnce(newConnection);

      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g1", channelId: "1002" });

      const oldDestroyed = oldConnection.handlers.get("destroyed");
      expect(oldDestroyed).toBeTypeOf("function");
      oldDestroyed?.();

      expectConnectedStatus(manager, "1002");
      await manager.destroy();
    });

    it("destroys stale tracked voice connections before joining", async () => {
      const staleConnection = createConnectionMock();
      const connection = createConnectionMock();
      getVoiceConnectionMock.mockReturnValueOnce(staleConnection);
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      expect(getVoiceConnectionMock).toHaveBeenCalledWith("g1", "openclaw:default");
      expect(staleConnection.destroy).toHaveBeenCalledTimes(1);
      expectConnectedStatus(manager, "1001");
    });

    it("isolates voice connections by Discord account", async () => {
      const firstManager = createManager(undefined, undefined, undefined, "first");
      const secondManager = createManager(undefined, undefined, undefined, "second");

      await firstManager.join({ guildId: "g1", channelId: "1001" });
      await secondManager.join({ guildId: "g1", channelId: "1002" });

      expect(getVoiceConnectionMock).toHaveBeenNthCalledWith(1, "g1", "openclaw:first");
      expect(getVoiceConnectionMock).toHaveBeenNthCalledWith(2, "g1", "openclaw:second");
      expect(joinVoiceChannelMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ group: "openclaw:first" }),
      );
      expect(joinVoiceChannelMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ group: "openclaw:second" }),
      );
    });

    const missingAccessError = new DiscordError(new Response(null, { status: 403 }), {
      message: "Missing Access",
      code: 50001,
    });
    const unknownChannelError = new DiscordError(new Response(null, { status: 404 }), {
      message: "Unknown Channel",
      code: 10003,
    });
    const networkError = new TypeError("fetch failed");

    it.each([
      {
        name: "preserves Discord 403 / 50001 Missing Access",
        response: missingAccessError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: Missing Access",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "preserves Discord 404 / 10003 Unknown Channel",
        response: unknownChannelError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: Unknown Channel",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "preserves generic network failures",
        response: networkError,
        expected: {
          ok: false,
          message: "Failed to resolve Discord channel 1001: fetch failed",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "rejects a fetched GuildText channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildText },
        expected: { ok: false, message: "Channel 1001 is not a voice channel." },
      },
      {
        name: "accepts a fetched GuildVoice channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildVoice },
        expected: {
          ok: true,
          message: "Joined <#1001>.",
          guildId: "g1",
          channelId: "1001",
        },
      },
      {
        name: "accepts a fetched GuildStageVoice channel",
        response: { id: "1001", guildId: "g1", type: ChannelType.GuildStageVoice },
        expected: {
          ok: true,
          message: "Joined <#1001>.",
          guildId: "g1",
          channelId: "1001",
        },
      },
    ])("$name", async ({ response, expected }) => {
      const client = createClient();
      client.fetchChannel.mockImplementationOnce(async () => {
        if (response instanceof Error) {
          throw response;
        }
        return response as never;
      });
      const manager = createManager(undefined, client);

      await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toEqual(expected);
    });

    it("keeps cancellation authoritative when channel lookup later rejects", async () => {
      let rejectChannelLookup!: (reason: unknown) => void;
      const client = createClient();
      client.fetchChannel.mockImplementationOnce(
        async () =>
          await new Promise<never>((_, reject) => {
            rejectChannelLookup = reject;
          }),
      );
      const manager = createManager(undefined, client);

      const join = manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(client.fetchChannel).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      rejectChannelLookup(missingAccessError);

      await expect(join).resolves.toEqual({
        ok: false,
        message: "Discord voice join was cancelled.",
        guildId: "g1",
        channelId: "1001",
      });
    });

    it("removes voice listeners on leave", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.leave({ guildId: "g1" });

      const player = createAudioPlayerMock.mock.results[0]?.value;
      expectOffEventWithFunction(connection.receiver.speaking.off, "start");
      expectOffEventWithFunction(connection.receiver.speaking.off, "end");
      expectOffEventWithFunction(connection.off, "disconnected");
      expectOffEventWithFunction(connection.off, "destroyed");
      expectOffEventWithFunction(player.off, "error");
    });

    it("force-stops buffering playback when leaving a voice session", async () => {
      const manager = createManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const player = getLastAudioPlayer();
      player.state.status = "buffering";

      await manager.leave({ guildId: "g1" });

      expect(player.stop).toHaveBeenCalledWith(true);
    });

    it("ignores new capture while playback is running", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      const player = getLastAudioPlayer();
      const entry = getSessionEntry(manager);
      player.state.status = "playing";

      await handleSpeakingStart(manager, entry, "u1");

      expect(player.stop).not.toHaveBeenCalled();
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it("allows configured realtime barge-in when provider input interruption is disabled", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { bridgeParams, entry, manager, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      player.state.status = "playing";
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      await handleSpeakingStart(manager, entry, "u1");

      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      const subscribeCall = lastMockCall(
        connection.receiver.subscribe as unknown as MockCallSource,
        "receiver subscribe",
      );
      expect(subscribeCall?.[0]).toBe("u1");
      expect(requireRecord(subscribeCall?.[1], "subscribe options").end).toBeTypeOf("object");
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    });

    it("interrupts realtime playback when an already-active speaker keeps talking", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { bridgeParams, entry, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: null });

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      turn.sendInputAudio(Buffer.alloc(3840));

      expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(0);
      expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(10);
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalled();
      const lastTimestampCall =
        realtimeSessionMock.setMediaTimestamp.mock.invocationCallOrder.at(-1);
      const firstBargeInCall = realtimeSessionMock.handleBargeIn.mock.invocationCallOrder[0];
      expect(expectDefined(lastTimestampCall, "last media timestamp invocation")).toBeLessThan(
        expectDefined(firstBargeInCall, "first barge-in invocation"),
      );
      expect(player.stop).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    });

    it("does not interrupt realtime provider state when local playback is already idle", async () => {
      const { entry, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            bargeIn: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
    });

    it("sends trailing realtime silence when a speaker turn closes", async () => {
      const { entry } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            providers: {
              openai: {
                silenceDurationMs: 450,
              },
            },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });
      turn.close();

      expect(realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(2);
      const trailingSilence = realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
        | Buffer
        | undefined;
      expect(trailingSilence).toBeInstanceOf(Buffer);
      expect(trailingSilence?.length).toBe(33_600);
      expect(trailingSilence?.equals(Buffer.alloc(33_600))).toBe(true);
    });

    it("clamps configured realtime trailing silence before allocating audio", async () => {
      const { entry } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: {
          realtime: {
            providers: {
              openai: {
                silenceDurationMs: 60_000,
              },
            },
          },
        },
      });
      const turn = beginSpeakerTurn(entry, { userId: "u1", initialAudio: Buffer.alloc(3840) });
      turn.close();

      const trailingSilence = realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
        | Buffer
        | undefined;
      expect(trailingSilence).toBeInstanceOf(Buffer);
      expect(trailingSilence?.length).toBe(144_000);
      expect(trailingSilence?.equals(Buffer.alloc(144_000))).toBe(true);
    });

    it("ignores realtime capture during playback when barge-in is disabled", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { entry, manager, player } = await createJoinedBidiFixture({
        allowFrom: ["discord:u1"],
        voice: { realtime: { bargeIn: false } },
      });
      player.state.status = "playing";

      await handleSpeakingStart(manager, entry, "u1");

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it("passes DAVE options to joinVoiceChannel", async () => {
      const manager = createManager({
        voice: {
          daveEncryption: false,
          decryptionFailureTolerance: 8,
        },
      });

      await manager.join({ guildId: "g1", channelId: "1001" });

      const joinOptions = requireRecord(
        mockCall(joinVoiceChannelMock as unknown as MockCallSource, 0, "join voice call")[0],
        "join voice options",
      );
      expect(joinOptions.daveEncryption).toBe(false);
      expect(joinOptions.decryptionFailureTolerance).toBe(8);
    });

    it("uses the default timeout for initial voice connection readiness", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      const readyCall = entersStateMock.mock.calls[0];
      expect(readyCall?.[0]).toBe(connection);
      expect(readyCall?.[1]).toBe("ready");
      expect(readyCall?.[2]).toBeGreaterThanOrEqual(29_900);
      expect(readyCall?.[2]).toBeLessThanOrEqual(30_000);
    });

    it("deduplicates concurrent joins for the same guild and channel", async () => {
      const connection = createConnectionMock();
      const waiting = createDeferred<void>();
      const ready = createDeferred<undefined>();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockImplementationOnce(() => {
        waiting.resolve();
        return ready.promise;
      });
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const secondJoin = manager.join({ guildId: "g1", channelId: "1001" });
      await waiting.promise;

      try {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      } finally {
        ready.resolve(undefined);
      }

      const [firstResult, secondResult] = await Promise.all([firstJoin, secondJoin]);

      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(entersStateMock).toHaveBeenCalledTimes(1);
    });

    it("serializes queued joins after an active guild join settles", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      const thirdConnection = createConnectionMock();
      const waiting = createDeferred<void>();
      const firstReady = createDeferred<undefined>();
      const secondReady = createDeferred<undefined>();
      const thirdReady = createDeferred<undefined>();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection)
        .mockReturnValueOnce(thirdConnection);
      entersStateMock
        .mockImplementationOnce(() => {
          waiting.resolve();
          return firstReady.promise;
        })
        .mockImplementationOnce(() => secondReady.promise)
        .mockImplementationOnce(() => thirdReady.promise);
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
      const thirdJoin = manager.join({ guildId: "g1", channelId: "1003" });
      await waiting.promise;

      try {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);

        firstReady.resolve(undefined);
        await firstJoin;
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
        expect(entersStateMock).toHaveBeenCalledTimes(2);

        secondReady.resolve(undefined);
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3));
        thirdReady.resolve(undefined);
        const [secondResult, thirdResult] = await Promise.all([secondJoin, thirdJoin]);

        expect(secondResult.ok).toBe(true);
        expect(thirdResult.ok).toBe(true);
        expect(entersStateMock).toHaveBeenCalledTimes(3);
      } finally {
        firstReady.resolve(undefined);
        secondReady.resolve(undefined);
        thirdReady.resolve(undefined);
        await Promise.all([firstJoin, secondJoin, thirdJoin]);
      }
    });

    it("does not start queued joins after the voice manager is destroyed", async () => {
      const connection = createConnectionMock();
      const waiting = createDeferred<void>();
      const ready = createDeferred<undefined>();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockImplementationOnce(() => {
        waiting.resolve();
        return ready.promise;
      });
      const manager = createManager();

      const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
      const queuedJoin = manager.join({ guildId: "g1", channelId: "1002" });
      await waiting.promise;

      try {
        await manager.destroy();
      } finally {
        ready.resolve(undefined);
      }
      const [firstResult, queuedResult] = await Promise.all([firstJoin, queuedJoin]);

      expect(firstResult.ok).toBe(false);
      expect(queuedResult.ok).toBe(false);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    });

    it("retries an aborted initial voice connection readiness wait", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection);
      entersStateMock
        .mockRejectedValueOnce(new Error("The operation was aborted"))
        .mockResolvedValueOnce(undefined);
      const manager = createManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expect(entersStateMock).toHaveBeenCalledTimes(2);
      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(secondConnection.destroy).not.toHaveBeenCalled();
      expectConnectedStatus(manager, "1001");
    });

    it("does not retry an aborted voice connection readiness wait after the timeout budget is spent", async () => {
      const nowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(30_000);
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockRejectedValueOnce(new Error("The operation was aborted"));
      const manager = createManager();

      try {
        const result = await manager.join({ guildId: "g1", channelId: "1001" });

        expect(result.ok).toBe(false);
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
        expect(entersStateMock).toHaveBeenCalledTimes(1);
        expect(connection.destroy).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("does not retry an aborted voice connection readiness wait after destroy", async () => {
      const firstConnection = createConnectionMock();
      const secondConnection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(secondConnection);
      entersStateMock.mockImplementationOnce(async () => {
        await manager.destroy();
        throw new Error("The operation was aborted");
      });
      const manager: InstanceType<typeof managerModule.DiscordVoiceManager> = createManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(false);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(secondConnection.destroy).not.toHaveBeenCalled();
    });

    it("uses configured voice connection and reconnect timeouts", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager({
        voice: {
          connectTimeoutMs: 45_000,
          reconnectGraceMs: 20_000,
        },
      });

      await manager.join({ guildId: "g1", channelId: "1001" });

      const readyCall = entersStateMock.mock.calls[0];
      expect(readyCall?.[0]).toBe(connection);
      expect(readyCall?.[1]).toBe("ready");
      expect(readyCall?.[2]).toBeGreaterThanOrEqual(44_900);
      expect(readyCall?.[2]).toBeLessThanOrEqual(45_000);

      entersStateMock.mockClear();
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

      const disconnected = connection.handlers.get("disconnected");
      expect(disconnected).toBeTypeOf("function");
      await disconnected?.();

      expect(entersStateMock).toHaveBeenCalledWith(connection, "signalling", 20_000);
      expect(entersStateMock).toHaveBeenCalledWith(connection, "connecting", 20_000);
      await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
    });

    it("uses the default reconnect grace before destroying disconnected sessions", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      connection.handlers.get("disconnected")?.();
      await vi.waitFor(() =>
        expect(entersStateMock).toHaveBeenCalledWith(connection, "connecting", 15_000),
      );

      entersStateMock.mockClear();
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

      const disconnected = connection.handlers.get("disconnected");
      expect(disconnected).toBeTypeOf("function");
      await disconnected?.();

      expect(entersStateMock).toHaveBeenCalledWith(connection, "signalling", 15_000);
      expect(entersStateMock).toHaveBeenCalledWith(connection, "connecting", 15_000);
      await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
    });

    it("closes realtime sessions when disconnected recovery destroys the connection", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { manager } = await createJoinedAgentProxyFixture();

      entersStateMock.mockClear();
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
      entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

      const disconnected = connection.handlers.get("disconnected");
      expect(disconnected).toBeTypeOf("function");
      await disconnected?.();

      await vi.waitFor(() => expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(manager.status()).toStrictEqual([]));
    });

    it("closes realtime sessions when Discord destroys the connection", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const { manager } = await createJoinedAgentProxyFixture();

      const destroyed = connection.handlers.get("destroyed");
      expect(destroyed).toBeTypeOf("function");
      destroyed?.();

      expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(manager.status()).toStrictEqual([]);
    });
  },
);
