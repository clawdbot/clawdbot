import { DiscordError } from "../internal/discord.js";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    ChannelType,
    requireRecord,
    mockCall,
    joinVoiceChannelMock,
    entersStateMock,
    resolveAgentRouteMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    createRealtimeVoiceBridgeSessionMock,
    realtimeSessionMock,
    managerModule,
    configureVoiceStateGateway,
    createClient,
    createManager,
    makeVoiceConfig,
    expectConnectedStatus,
    updateVoiceState,
  }) => {
    it("autoJoin uses the last configured channel for duplicate guild entries", async () => {
      const manager = createManager({
        voice: {
          enabled: true,
          autoJoin: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g1", channelId: "1002" },
          ],
        },
      });

      await manager.autoJoin();

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      const joinOptions = requireRecord(
        mockCall(joinVoiceChannelMock as unknown as MockCallSource, 0, "join voice call")[0],
        "join voice options",
      );
      expect(joinOptions.guildId).toBe("g1");
      expect(joinOptions.channelId).toBe("1002");
      expectConnectedStatus(manager, "1002");
    });

    it("auto-joins an occupied room after the startup guild snapshot arrives", async () => {
      const client = createClient();
      let voiceStates: Array<Record<string, unknown>> = [];
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
      expect(manager.status()).toEqual([]);

      voiceStates = [
        {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1001",
          member: { user: { id: "u-owner", bot: false } },
        },
      ];
      const { DiscordVoiceGuildCreateListener } = managerModule;
      const listener = new DiscordVoiceGuildCreateListener(manager);
      await listener.handle({ id: "g1", unavailable: false } as never, client as never);

      await vi.waitFor(() => expectConnectedStatus(manager, "1001"));
    });

    it("does not join for a participant whose human identity is unresolved", async () => {
      const client = createClient();
      configureVoiceStateGateway(client, () => [
        {
          guild_id: "g1",
          user_id: "unknown-member",
          channel_id: "1001",
        },
      ]);
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

      expect(manager.status()).toEqual([]);
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });

    it("joins on the first human arrival and leaves when only bots remain", async () => {
      const client = createClient();
      const botState = {
        guild_id: "g1",
        user_id: "helper-bot",
        channel_id: "1001",
        member: { user: { id: "helper-bot", bot: true } },
      };
      const humanState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
        member: { user: { id: "u-owner", bot: false } },
      };
      let voiceStates: Array<Record<string, unknown>> = [botState];
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
      expect(manager.status()).toEqual([]);

      voiceStates = [botState, humanState];
      await updateVoiceState(manager, "u-owner", "1001", humanState.member);
      expectConnectedStatus(manager, "1001");

      voiceStates = [botState];
      await updateVoiceState(manager, "u-owner", null, humanState.member);
      expect(manager.status()).toEqual([]);
    });

    it.each(["1001", "1002"])(
      "does not claim or disconnect a manual session in channel %s",
      async (manualChannelId) => {
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

        await manager.join({ guildId: "g1", channelId: manualChannelId });
        await manager.autoJoin();
        voiceStates = [];
        await updateVoiceState(manager, "u-owner", null, humanState.member);

        expectConnectedStatus(manager, manualChannelId);
      },
    );

    it("applies the latest occupancy after a pending auto-join finishes", async () => {
      const client = createClient();
      const humanState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
        member: { user: { id: "u-owner", bot: false } },
      };
      let voiceStates: Array<Record<string, unknown>> = [humanState];
      configureVoiceStateGateway(client, () => voiceStates);
      let resolveReady!: () => void;
      entersStateMock.mockImplementationOnce(
        async () =>
          await new Promise<undefined>((resolve) => {
            resolveReady = () => resolve(undefined);
          }),
      );
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
        }),
        client,
        {},
        "default",
        "bot-user",
      );

      const joining = manager.autoJoin();
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1));
      voiceStates = [];
      const leaving = updateVoiceState(manager, "u-owner", null, humanState.member);
      resolveReady();
      await Promise.all([joining, leaving]);

      expect(manager.status()).toEqual([]);
    });

    it("preserves the routed agent through realtime autoJoin startup", async () => {
      resolveAgentRouteMock.mockReturnValue({
        agentId: "molty",
        sessionKey: "agent:molty:discord:channel:g1:1001",
      });
      resolveConfiguredRealtimeVoiceProviderMock.mockImplementation((params?: unknown) => {
        if (requireRecord(params, "provider resolution params").agentId !== "molty") {
          throw new Error("AGENT_SELECTION_REQUIRED: expected routed agent molty");
        }
        return {
          provider: { id: "openai", capabilities: { supportsActivationNameGating: true } },
          providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
        };
      });
      createRealtimeVoiceBridgeSessionMock.mockImplementation((params?: unknown) => {
        if (requireRecord(params, "bridge session params").agentId !== "molty") {
          throw new Error("AGENT_SELECTION_REQUIRED: expected routed agent molty");
        }
        return realtimeSessionMock;
      });
      const manager = createManager(
        makeVoiceConfig({
          mode: "agent-proxy",
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
          realtime: { provider: "openai" },
        }),
        undefined,
        { agents: { list: [{ id: "helper" }, { id: "molty" }] } },
      );

      await manager.autoJoin();

      expect(resolveConfiguredRealtimeVoiceProviderMock).toHaveBeenCalledTimes(1);
      expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1);
      expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
      expectConnectedStatus(manager, "1001");
    });

    it("suppresses repeated autoJoin attempts after fatal realtime startup failures", async () => {
      realtimeSessionMock.connect.mockRejectedValueOnce(new Error("Incorrect API key provided"));
      const manager = createManager(
        makeVoiceConfig({
          mode: "agent-proxy",
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
        }),
      );

      await manager.autoJoin();
      await manager.autoJoin();

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
      expect(manager.status()).toStrictEqual([]);
    });

    it("rejects joins outside configured allowed voice channels", async () => {
      const manager = createManager(
        makeVoiceConfig({ allowedChannels: [{ guildId: "g1", channelId: "1001" }] }),
      );

      const result = await manager.join({ guildId: "g1", channelId: "1002" });

      expect(result.ok).toBe(false);
      expect(result.message).toBe(
        "<#1002> is not allowed by channels.discord.voice.allowedChannels.",
      );
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });

    it("allows joins inside configured allowed voice channels", async () => {
      const manager = createManager(
        makeVoiceConfig({ allowedChannels: [{ guildId: "g1", channelId: "1001" }] }),
      );

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      expectConnectedStatus(manager, "1001");
    });

    it("continues autoJoin after a channel resolution failure", async () => {
      const missingAccessError = new DiscordError(new Response(null, { status: 403 }), {
        message: "Missing Access",
        code: 50001,
      });
      const client = createClient();
      client.fetchChannel.mockRejectedValueOnce(missingAccessError).mockResolvedValueOnce({
        id: "2001",
        guildId: "g2",
        guild: { id: "g2", name: "Guild 2" },
        type: ChannelType.GuildVoice,
      });
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g2", channelId: "2001" },
          ],
        }),
        client,
      );

      await expect(manager.autoJoin()).resolves.toBeUndefined();

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(manager.status()).toEqual([
        {
          ok: true,
          message: "connected: guild g2 channel 2001",
          guildId: "g2",
          channelId: "2001",
        },
      ]);
    });
  },
);
