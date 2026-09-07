import { PassThrough, type Readable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    VoiceOpcodes,
    expect,
    it,
    vi,
    ChannelType,
    createVoiceCaptureState,
    DECRYPT_FAILURE_WINDOW_MS,
    requireRecord,
    lastMockCall,
    createConnectionMock,
    joinVoiceChannelMock,
    transcribeAudioFileMock,
    resolveVoiceIngressWithParticipantsMock,
    loggerWarnMock,
    realtimeSessionMock,
    decodeOpusStreamChunksMock,
    createClient,
    createManager,
    createAgentProxyManager,
    makeVoiceConfig,
    configureVoiceStateGateway,
    createFollowManager,
    expectConnectedStatus,
    getSessionEntry,
    getLastAudioPlayer,
    getVoiceReceive,
    getVoiceFollowing,
    emitDecryptFailure,
    installFailingDaveSession,
    makePoisonedDaveConnections,
    updateVoiceState,
    handleSpeakingStart,
    startTranscripts,
    stopTranscripts,
    beginSpeakerTurn,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    receiveRecordedSpeech,
    agentCommandMock,
  }) => {
    it.each(["agent-proxy", "bidi"] as const)(
      "keeps exact capture and %s conversation after destructive recovery",
      async (mode) => {
        const manager = createManager(
          makeVoiceConfig(
            { mode, realtime: { provider: "openai", requireWakeName: true } },
            { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
          ),
        );
        await manager.join({ guildId: "g1", channelId: "1001" });
        const onUtterance = vi.fn();
        expect(await startTranscripts(manager, onUtterance)).toMatchObject({ ok: true });
        await receiveRecordedSpeech(manager, "before recovery");
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "before recovery");
        expect(onUtterance).toHaveBeenCalledOnce();
        const oldEntry = getSessionEntry(manager);
        emitDecryptFailure(manager);
        emitDecryptFailure(manager);
        emitDecryptFailure(manager);
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
        await receiveRecordedSpeech(manager, "after recovery");
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "after recovery");
        expect(onUtterance).toHaveBeenCalledTimes(2);
        expect(agentCommandMock).not.toHaveBeenCalled();
        await receiveRecordedSpeech(manager, "stale connection", oldEntry);
        expect(onUtterance).toHaveBeenCalledTimes(2);
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        expectConnectedStatus(manager, "1001");
        beginSpeakerTurn(getSessionEntry(manager));
        if (mode === "agent-proxy") {
          await emitFinalRealtimeUserTranscript(
            lastRealtimeBridgeParams(),
            "OpenClaw, what changed?",
          );
        } else {
          await lastRealtimeBridgeParams().onToolCall?.(
            {
              itemId: "consult-after-recovery",
              callId: "consult-after-recovery",
              name: "openclaw_agent_consult",
              args: { question: "what changed?" },
            },
            realtimeSessionMock,
          );
        }
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(onUtterance).toHaveBeenCalledTimes(2);
      },
    );
    it("authorizes realtime speakers before subscribing receiver streams", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Denied Speaker",
        roles: [],
        user: {
          id: "u-denied",
          username: "denied",
          globalName: "Denied",
          discriminator: "3333",
        },
      });
      const manager = createManager(
        {
          groupPolicy: "allowlist",
          guilds: {
            g1: {
              channels: {
                "1001": {
                  roles: ["role:voice-allowed"],
                },
              },
            },
          },
          voice: {
            enabled: true,
            mode: "bidi",
            realtime: {
              provider: "openai",
              model: "gpt-realtime-2",
            },
          },
        },
        client,
      );

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      if (!entry) {
        throw new Error("expected voice session for guild g1");
      }
      expect(entry.player.state.status).toBe("idle");
      getLastAudioPlayer().state.status = "playing";

      await handleSpeakingStart(manager, entry, "u-denied");

      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(client.fetchMember).toHaveBeenCalledWith("g1", "u-denied");
    });

    it("owns start/end/start during realtime admission without subscribing before authorization", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createAgentProxyManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const admission = createDeferred<DiscordVoiceIngressContext | null>();
      resolveVoiceIngressWithParticipantsMock.mockReturnValue(admission.promise);
      vi.useFakeTimers();
      try {
        const first = handleSpeakingStart(manager, entry, "u-speaker");
        getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-speaker", "speaker end");
        const resumed = handleSpeakingStart(manager, entry, "u-speaker");
        expect(resolveVoiceIngressWithParticipantsMock).toHaveBeenCalledOnce();
        expect(connection.receiver.subscribe).not.toHaveBeenCalled();
        expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_500);
        expect(entry.capture.size).toBe(1);

        admission.resolve({ speakerLabel: "Speaker", senderIsOwner: false });
        await Promise.all([first, resumed]);
        expect(connection.receiver.subscribe).toHaveBeenCalledOnce();
        expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
        expect(entry.capture.size).toBe(0);
      } finally {
        admission.resolve(null);
        await manager.destroy();
        vi.useRealTimers();
      }
    });

    it.each(["denied", "failed", "stopped", "silence expired"] as const)(
      "retires %s realtime admission without a late subscription",
      async (reason) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createAgentProxyManager();
        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        const admission = createDeferred<DiscordVoiceIngressContext | null>();
        resolveVoiceIngressWithParticipantsMock.mockReturnValue(admission.promise);
        vi.useFakeTimers();
        try {
          const completion = handleSpeakingStart(manager, entry, "u-speaker");
          const outcome =
            reason === "failed"
              ? expect(completion).rejects.toThrow("admission failed")
              : expect(completion).resolves.toBeUndefined();
          getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-speaker", "speaker end");
          expect(connection.receiver.subscribe).not.toHaveBeenCalled();
          if (reason === "stopped") {
            await manager.destroy();
          } else if (reason === "silence expired") {
            await vi.advanceTimersByTimeAsync(2_500);
          }
          if (reason === "failed") {
            admission.reject(new Error("admission failed"));
          } else {
            admission.resolve(
              reason === "denied" ? null : { speakerLabel: "Speaker", senderIsOwner: false },
            );
          }
          await outcome;
          await vi.advanceTimersByTimeAsync(2_500);
          expect(connection.receiver.subscribe).not.toHaveBeenCalled();
          expect(decodeOpusStreamChunksMock).not.toHaveBeenCalled();
          expect(entry.capture.size).toBe(0);
        } finally {
          admission.resolve(null);
          await manager.destroy();
          vi.useRealTimers();
        }
      },
    );

    it("stores guild metadata on joined voice sessions", async () => {
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      const entry = getSessionEntry(manager);
      expect(entry?.guildName).toBe("Guild One");
    });

    it("enables DAVE receive passthrough after join", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 30);
    });

    it("invalidates transition zero before re-arming receive passthrough", async () => {
      const connection = createConnectionMock();
      const dave = connection.state.networking.state.dave;
      dave.lastTransitionId = 0;
      dave.reinitializing = false;
      dave.recoverFromInvalidTransition = vi.fn();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      connection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);

      expect(dave.recoverFromInvalidTransition).toHaveBeenCalledOnce();
      expect(dave.recoverFromInvalidTransition).toHaveBeenCalledWith(0);
      expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
      expect(dave.recoverFromInvalidTransition.mock.invocationCallOrder[0]).toBeLessThan(
        connection.daveSetPassthroughMode.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });

    it.each([
      {
        label: "non-zero transitions",
        lastTransitionId: 1,
        reinitializing: false,
        networkingStatus: "networking-ready",
      },
      {
        label: "missing transitions",
        lastTransitionId: undefined,
        reinitializing: false,
        networkingStatus: "networking-ready",
      },
      {
        label: "transitions already reinitializing",
        lastTransitionId: 0,
        reinitializing: true,
        networkingStatus: "networking-ready",
      },
      {
        label: "resuming networking",
        lastTransitionId: 0,
        reinitializing: false,
        networkingStatus: "networking-resuming",
      },
    ])(
      "does not invalidate $label",
      async ({ lastTransitionId, reinitializing, networkingStatus }) => {
        const connection = createConnectionMock();
        const dave = connection.state.networking.state.dave;
        dave.lastTransitionId = lastTransitionId;
        dave.reinitializing = reinitializing;
        dave.recoverFromInvalidTransition = vi.fn();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager();

        await manager.join({ guildId: "g1", channelId: "1001" });
        connection.state.networking.state.code = networkingStatus;

        emitDecryptFailure(manager);

        expect(dave.recoverFromInvalidTransition).not.toHaveBeenCalled();
      },
    );

    it("does not invalidate a stale voice-session transition", async () => {
      const staleConnection = createConnectionMock();
      const staleDave = staleConnection.state.networking.state.dave;
      staleDave.lastTransitionId = 0;
      staleDave.reinitializing = false;
      staleDave.recoverFromInvalidTransition = vi.fn();
      joinVoiceChannelMock
        .mockReturnValueOnce(staleConnection)
        .mockReturnValueOnce(createConnectionMock());
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      const staleEntry = getSessionEntry(manager);
      await manager.join({ guildId: "g1", channelId: "1002" });

      getVoiceReceive(manager).handleReceiveError(
        staleEntry,
        new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
      );

      expect(staleDave.recoverFromInvalidTransition).not.toHaveBeenCalled();
    });

    it("does not invalidate a stopped voice-session transition", async () => {
      const connection = createConnectionMock();
      const dave = connection.state.networking.state.dave;
      dave.lastTransitionId = 0;
      dave.reinitializing = false;
      dave.recoverFromInvalidTransition = vi.fn();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      entry.sessionLifecycle = { status: "stopped", reason: "test" };

      emitDecryptFailure(manager);

      expect(dave.recoverFromInvalidTransition).not.toHaveBeenCalled();
    });

    it("does not invalidate transition zero for unrelated receive failures", async () => {
      const connection = createConnectionMock();
      const dave = connection.state.networking.state.dave;
      dave.lastTransitionId = 0;
      dave.reinitializing = false;
      dave.recoverFromInvalidTransition = vi.fn();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      getVoiceReceive(manager).handleReceiveError(
        getSessionEntry(manager),
        new Error("DecryptionFailed(InvalidCiphertext)"),
      );

      expect(dave.recoverFromInvalidTransition).not.toHaveBeenCalled();
    });

    it("keeps passthrough and bounded rejoin when zero-transition recovery throws", async () => {
      const connection = createConnectionMock();
      const dave = connection.state.networking.state.dave;
      dave.lastTransitionId = 0;
      dave.reinitializing = false;
      dave.recoverFromInvalidTransition = vi.fn(() => {
        throw new Error("voice gateway unavailable");
      });
      joinVoiceChannelMock
        .mockReturnValueOnce(connection)
        .mockReturnValueOnce(createConnectionMock());
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      connection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);

      await vi.waitFor(() => {
        expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      });
    });

    it.each([
      { label: "gateway invalidation", failure: "invalidation" as const },
      { label: "native DAVE reinitialization", failure: "native" as const },
      { label: "MLS key-package delivery", failure: "key-package" as const },
    ])(
      "immediately rejoins after $label leaves the real DAVE session poisoned",
      async ({ failure }) => {
        const connection = createConnectionMock();
        const { dave, gateway } = installFailingDaveSession(connection, failure);
        joinVoiceChannelMock
          .mockReturnValueOnce(connection)
          .mockReturnValueOnce(createConnectionMock());
        const manager = createManager();

        await manager.join({ guildId: "g1", channelId: "1001" });
        connection.daveSetPassthroughMode.mockClear();
        expect(() => dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toThrow(
          "UnencryptedWhenPassthroughDisabled",
        );

        emitDecryptFailure(manager);

        expect(dave.reinitializing).toBe(true);
        expect(gateway.sendPacket).toHaveBeenCalledWith({
          op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
          d: { transition_id: 0 },
        });
        expect(gateway.sendBinaryMessage).toHaveBeenCalledTimes(failure === "key-package" ? 1 : 0);
        expect(connection.daveSetPassthroughMode).not.toHaveBeenCalled();
        expect(dave.decrypt(Buffer.from("encrypted-audio"), "speaker")).toBeNull();
        expect(connection.destroy).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      },
    );

    it("does not duplicate an in-flight reconnect after a real DAVE recovery fails", async () => {
      const connection = createConnectionMock();
      const { dave } = installFailingDaveSession(connection, "native");
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      entry.receiveRecovery.decryptRecoveryInFlight = true;
      connection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);

      expect(dave.reinitializing).toBe(true);
      expect(entry.receiveRecovery.decryptRecoveryInFlight).toBe(true);
      expect(connection.destroy).not.toHaveBeenCalled();
      expect(connection.daveSetPassthroughMode).not.toHaveBeenCalled();
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    });

    it("does not rejoin a voice session stopped during real DAVE recovery", async () => {
      const connection = createConnectionMock();
      const stopEntry: { current?: () => void } = {};
      const { dave } = installFailingDaveSession(connection, "native", () => stopEntry.current?.());
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      stopEntry.current = () => entry.stop();
      connection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);

      expect(dave.reinitializing).toBe(true);
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(connection.daveSetPassthroughMode).not.toHaveBeenCalled();
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
      expect(entry.receiveRecovery.decryptRecoveryInFlight).toBe(false);
    });

    it("disconnects after repeated poisoned DAVE sessions without a reconnect loop", async () => {
      const { firstConnection, secondConnection } = makePoisonedDaveConnections();
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      secondConnection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);

      expect(firstConnection.destroy).toHaveBeenCalledOnce();
      expect(secondConnection.destroy).toHaveBeenCalledOnce();
      expect(secondConnection.daveSetPassthroughMode).not.toHaveBeenCalled();
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expect(manager.status()).toEqual([]);
    });

    it("suppresses followed-user reconciliation until the poisoned-DAVE cooldown expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      makePoisonedDaveConnections(1);
      const client = createClient();
      client.rest.get.mockResolvedValue({
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
      });
      const manager = createFollowManager({}, client, { guilds: { g1: {} } });

      try {
        await manager.autoJoin();
        emitDecryptFailure(manager);
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
        emitDecryptFailure(manager);
        expect(manager.status()).toEqual([]);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
        const followedUsers = getVoiceFollowing(manager).followedUserChannels;
        expect(followedUsers.get("g1:u-owner")?.channelId).toBe("1001");

        await vi.advanceTimersByTimeAsync(20_000);

        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
        expectConnectedStatus(manager, "1001");
      } finally {
        await manager.destroy();
        vi.useRealTimers();
      }
    });

    it("suppresses repeated same-channel voice-state updates during a DAVE cooldown", async () => {
      makePoisonedDaveConnections();
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      emitDecryptFailure(manager);
      const previousVoiceState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
      };

      await manager.handleVoiceStateUpdate(
        { ...previousVoiceState, self_mute: true } as never,
        previousVoiceState as never,
      );
      await manager.handleVoiceStateUpdate(
        { ...previousVoiceState, self_deaf: true } as never,
        { ...previousVoiceState, self_mute: true } as never,
      );

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expect(manager.status()).toEqual([]);
    });

    it("still follows real user movement to another channel during a DAVE cooldown", async () => {
      makePoisonedDaveConnections(1);
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      emitDecryptFailure(manager);
      expect(manager.status()).toEqual([]);

      await updateVoiceState(manager, "u-owner", "1002");

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
      expectConnectedStatus(manager, "1002");
    });

    it("follows a user who leaves and rejoins the same channel during a DAVE cooldown", async () => {
      makePoisonedDaveConnections(1);
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      emitDecryptFailure(manager);

      await updateVoiceState(manager, "u-owner", null);
      await updateVoiceState(manager, "u-owner", "1001");

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
      expectConnectedStatus(manager, "1001");
    });

    it("reconciles a followed-user move to another channel during a DAVE cooldown", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      makePoisonedDaveConnections(1);
      const client = createClient();
      client.rest.get.mockResolvedValue({
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
      });
      const manager = createFollowManager({}, client, { guilds: { g1: {} } });

      try {
        await manager.autoJoin();
        emitDecryptFailure(manager);
        await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
        emitDecryptFailure(manager);
        client.rest.get.mockResolvedValue({
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1002",
        });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
        expectConnectedStatus(manager, "1002");
      } finally {
        await manager.destroy();
        vi.useRealTimers();
      }
    });

    it("allows explicit manual joins during a poisoned-DAVE cooldown", async () => {
      makePoisonedDaveConnections(1);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      emitDecryptFailure(manager);
      expect(manager.status()).toEqual([]);

      const manualJoin = await manager.join({ guildId: "g1", channelId: "1001" });
      expect(manualJoin).toEqual(expect.objectContaining({ ok: true }));
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
    });

    it("clears the poisoned-DAVE recovery budget after an intentional full leave", async () => {
      const firstConnection = createConnectionMock();
      const recoveredConnection = createConnectionMock();
      const manuallyJoinedConnection = createConnectionMock();
      const lastConnection = createConnectionMock();
      installFailingDaveSession(firstConnection, "native");
      installFailingDaveSession(manuallyJoinedConnection, "native");
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(recoveredConnection)
        .mockReturnValueOnce(manuallyJoinedConnection)
        .mockReturnValueOnce(lastConnection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);

      await manager.join({ guildId: "g1", channelId: "1001" });
      emitDecryptFailure(manager);

      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(4));
      expect(lastConnection.destroy).not.toHaveBeenCalled();
    });

    it("allows a poisoned-DAVE reconnect after the existing failure window expires", async () => {
      const firstConnection = createConnectionMock();
      installFailingDaveSession(firstConnection, "native");
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(createConnectionMock());
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
      attempts.set("g1", Date.now() - DECRYPT_FAILURE_WINDOW_MS);
      attempts.set("other-guild", Date.now());

      emitDecryptFailure(manager);

      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      expect(attempts.has("other-guild")).toBe(true);
    });

    it("keeps poisoned-DAVE reconnect budgets isolated between guilds", async () => {
      const firstGuildConnection = createConnectionMock();
      const secondGuildConnection = createConnectionMock();
      installFailingDaveSession(firstGuildConnection, "native");
      installFailingDaveSession(secondGuildConnection, "key-package");
      joinVoiceChannelMock
        .mockReturnValueOnce(firstGuildConnection)
        .mockReturnValueOnce(secondGuildConnection)
        .mockReturnValueOnce(createConnectionMock())
        .mockReturnValueOnce(createConnectionMock());
      const client = createClient();
      client.fetchChannel.mockImplementation(async (channelId: string) => {
        const guildId = channelId === "2001" ? "g2" : "g1";
        return {
          id: channelId,
          guildId,
          guild: { id: guildId, name: guildId },
          type: ChannelType.GuildVoice,
        };
      });
      const manager = createManager(undefined, client);

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join({ guildId: "g2", channelId: "2001" });
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3));
      getVoiceReceive(manager).handleReceiveError(
        getSessionEntry(manager, "g2"),
        new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
      );

      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(4));
      expect(manager.status()).toHaveLength(2);
    });

    it("clears poisoned-DAVE reconnect budgets when the manager is destroyed", async () => {
      const manager = createManager();
      const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
      attempts.set("g1", Date.now());

      await manager.destroy();

      expect(attempts.size).toBe(0);
    });

    it("re-arms passthrough but still rejoin-recovers after repeated decrypt failures", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(connection)
        .mockReturnValueOnce(createConnectionMock());
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      connection.daveSetPassthroughMode.mockClear();

      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);

      await vi.waitFor(() => {
        expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      });
    });

    it("preserves follow ownership through DAVE receive recovery", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(connection)
        .mockReturnValueOnce(createConnectionMock());
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");

      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);

      await vi.waitFor(() => {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      });
      await updateVoiceState(manager, "u-owner", null);

      expect(manager.status()).toEqual([]);
    });

    it("preserves occupied auto-join ownership through DAVE receive recovery", async () => {
      const firstConnection = createConnectionMock();
      joinVoiceChannelMock
        .mockReturnValueOnce(firstConnection)
        .mockReturnValueOnce(createConnectionMock());
      const client = createClient();
      const humanState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
        member: { user: { id: "u-owner", bot: false } },
      };
      let voiceStates: Array<Record<string, unknown>> = [humanState];
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
        }),
        client,
        {},
        "default",
        "bot-user",
      );
      await manager.autoJoin();

      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));

      voiceStates = [];
      await updateVoiceState(manager, "u-owner", null, humanState.member);

      expect(manager.status()).toEqual([]);
    });

    it("streams realtime with batch transcription disabled and resets receive recovery", async () => {
      const manager = createAgentProxyManager(
        undefined,
        { allowFrom: ["discord:u-speaker"] },
        { tools: { media: { audio: { enabled: false } } } },
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      const entry = getSessionEntry(manager);
      const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
      attempts.set("g1", Date.now());
      expect(entry.receiveRecovery.decryptFailureCount).toBe(2);
      await receiveRecordedSpeech(manager, undefined, entry, "u-speaker");
      expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(loggerWarnMock).not.toHaveBeenCalledWith(
        expect.stringContaining("audio understanding is disabled"),
      );
      expect(entry.receiveRecovery.decryptFailureCount).toBe(0);
      expect(entry.receiveRecovery.lastDecryptFailureAt).toBe(0);
      expect(attempts.has("g1")).toBe(false);
      expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
    });

    it.each([
      { mode: "agent-proxy", captureOnly: false },
      { mode: "bidi", captureOnly: false },
      { mode: "stt-tts", captureOnly: false },
      { mode: "stt-tts", captureOnly: true },
    ] as const)(
      "resets recovery once per stream while other speakers fail in $mode (captureOnly=$captureOnly)",
      async ({ mode, captureOnly }) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager(
          makeVoiceConfig(
            { mode, realtime: { provider: "openai" } },
            { groupPolicy: "open", allowFrom: ["discord:u-speaker", "discord:u-failing"] },
          ),
        );
        if (captureOnly) {
          expect(await startTranscripts(manager)).toMatchObject({ ok: true });
        } else {
          expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
            ok: true,
          });
        }
        const entry = getSessionEntry(manager);
        let decoded = createDeferred<void>();
        decodeOpusStreamChunksMock.mockImplementation(
          async (
            input: Readable,
            callbacks: { onChunk: (pcm: Buffer, packet: Buffer) => void | Promise<void> },
          ) => {
            for await (const packet of input) {
              await callbacks.onChunk(Buffer.alloc(packet[0] === 0 ? 0 : 3_840), packet);
              decoded.resolve();
            }
          },
        );
        const openStream = async (userId: string) => {
          const stream = new PassThrough({ objectMode: true });
          const subscribed = createDeferred<void>();
          connection.receiver.subscribe.mockImplementationOnce(() => {
            subscribed.resolve();
            return stream;
          });
          const receiving = handleSpeakingStart(manager, entry, userId);
          await subscribed.promise;
          return { stream, receiving };
        };
        const failOtherSpeaker = async () => {
          const other = await openStream("u-failing");
          // The native receiver destroys the speaker's subscription when decryption fails.
          other.stream.destroy(new Error("DecryptionFailed(InvalidCiphertext)"));
          await other.receiving;
        };
        const writePacket = async (stream: PassThrough, marker: number) => {
          decoded = createDeferred<void>();
          stream.write(Buffer.from([marker]));
          await decoded.promise;
        };
        const openHealthyStream = async () => {
          await failOtherSpeaker();
          await failOtherSpeaker();
          const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
          attempts.set("g1", Date.now());
          const healthy = await openStream("u-speaker");
          await writePacket(healthy.stream, 0);
          expect(entry.receiveRecovery.decryptFailureCount).toBe(2);
          expect(attempts.has("g1")).toBe(true);
          await writePacket(healthy.stream, 1);
          expect(entry.receiveRecovery.decryptFailureCount).toBe(0);
          expect(entry.receiveRecovery.lastDecryptFailureAt).toBe(0);
          expect(attempts.has("g1")).toBe(false);
          return healthy;
        };

        const first = await openHealthyStream();
        first.stream.end();
        await first.receiving;
        await entry.processingQueue;
        // A fresh stream on the same entry still gets its own successful-audio reset.
        const healthy = await openHealthyStream();
        try {
          for (let failure = 1; failure <= 3; failure++) {
            await failOtherSpeaker();
            if (failure < 3) {
              await writePacket(healthy.stream, 1);
              expect(connection.destroy).not.toHaveBeenCalled();
            }
          }
          await vi.waitFor(() => {
            expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
            expect(getSessionEntry(manager)).not.toBe(entry);
            expectConnectedStatus(manager, "1001");
          });
          expect(connection.destroy).toHaveBeenCalledOnce();
          expect(healthy.stream.destroyed).toBe(true);
          if (captureOnly) {
            expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
            expect(agentCommandMock).not.toHaveBeenCalled();
          }
        } finally {
          healthy.stream.destroy();
          await healthy.receiving;
          await manager.destroy();
        }
      },
    );

    it.each(["agent-proxy", "stt-tts"] as const)(
      "cleans up %s receive streams without clearing decoder failure state",
      async (mode) => {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const stream = new PassThrough({ objectMode: true });
        decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
          for await (const packet of input) {
            const err = new Error("memory access out of bounds");
            params.onError?.(err);
            stream.emit("error", err);
            await params.onChunk(Buffer.alloc(8), packet);
          }
        });
        const manager = createManager(
          makeVoiceConfig(
            { mode, realtime: { provider: "openai" } },
            { groupPolicy: "open", allowFrom: ["discord:u-speaker"] },
          ),
        );

        await manager.join({ guildId: "g1", channelId: "1001" });
        const entry = getSessionEntry(manager);
        connection.receiver.subscribe.mockReturnValueOnce(stream);

        const receiving = handleSpeakingStart(manager, entry, "u-speaker");
        stream.end(Buffer.from("opus-packet"));
        await receiving;
        await entry.processingQueue;

        expect(stream.destroyed).toBe(true);
        expect(stream.listenerCount("error")).toBe(0);
        expect(entry.capture.has("u-speaker")).toBe(false);
        expect(transcribeAudioFileMock).not.toHaveBeenCalled();
        expect(entry.receiveRecovery.decryptFailureCount).toBe(1);
        expect(entry.receiveRecovery.lastDecryptFailureAt).toBeGreaterThan(0);
      },
    );

    it("processes partial non-realtime audio after abort-like stream endings", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
        for await (const packet of input) {
          await params.onChunk(Buffer.alloc(48_000), packet);
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          params.onError?.(err);
        }
      });
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      );

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const conversations = vi.spyOn(entry.conversations, "enqueue");
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValueOnce(stream);

      const receiving = handleSpeakingStart(manager, entry, "u-speaker");
      stream.end(Buffer.from("opus-packet"));
      await receiving;
      await entry.processingQueue;
      await Promise.all(conversations.mock.results.map((result) => result.value));

      expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
      expect(entry.receiveRecovery.decryptFailureCount).toBe(0);
      expect(stream.destroyed).toBe(true);
    });

    it("allows the same speaker to restart after finalize fires", async () => {
      vi.useFakeTimers();
      try {
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const manager = createManager();

        await manager.join({ guildId: "g1", channelId: "1001" });

        const entry = getSessionEntry(manager);

        const firstStream = new PassThrough();
        const destroyFirstStream = vi.spyOn(firstStream, "destroy");
        entry.capture.set("u1", { stream: firstStream });

        getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u1", "test");

        await vi.advanceTimersByTimeAsync(2_500);

        expect(destroyFirstStream).toHaveBeenCalledTimes(1);
        expect(entry.capture.has("u1")).toBe(false);

        const secondStream = new PassThrough({ objectMode: true });
        connection.receiver.subscribe.mockReturnValueOnce(secondStream);

        await handleSpeakingStart(manager, entry, "u1");

        const subscribeCall = lastMockCall(
          connection.receiver.subscribe as unknown as MockCallSource,
          "receiver subscribe",
        );
        expect(subscribeCall?.[0]).toBe("u1");
        expect(
          requireRecord(requireRecord(subscribeCall?.[1], "subscribe options").end, "end").behavior,
        ).toBe("Manual");
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses configured silence grace before finalizing voice capture", async () => {
      vi.useFakeTimers();
      try {
        const manager = createManager({
          voice: {
            enabled: true,
            captureSilenceGraceMs: 4_000,
          },
        });
        const stream = { destroy: vi.fn() };
        const entry = {
          guildId: "g1",
          channelId: "1001",
          capture: createVoiceCaptureState(),
        };
        entry.capture.set("u1", {
          stream: stream as unknown as Readable,
        });

        getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u1", "test");

        await vi.advanceTimersByTimeAsync(3_999);
        expect(stream.destroy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(stream.destroy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
