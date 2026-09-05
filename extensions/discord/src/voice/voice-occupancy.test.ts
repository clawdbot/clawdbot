import { GatewayDispatchEvents, type APIVoiceState } from "../internal/discord.js";
import { DiscordGatewayVoiceStateCache } from "../internal/gateway-voice-state-cache.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createClient,
    createManager,
    configureVoiceStateGateway,
    managerModule,
    createRealtimeVoiceBridgeSessionMock,
    makeAgentProxyConfig,
    ChannelType,
  }) => {
    const room = { guildId: "g1", channelId: "1001" };
    const voiceState = (userId: string, channelId: string | null, bot = false): APIVoiceState =>
      ({
        guild_id: "g1",
        user_id: userId,
        channel_id: channelId,
        member: { user: { id: userId, bot } },
      }) as APIVoiceState;

    const fixture = () => {
      const cache = new DiscordGatewayVoiceStateCache();
      const client = createClient();
      configureVoiceStateGateway(client, (guildId, channelId) =>
        cache.listVoiceChannelStates(String(guildId), String(channelId)),
      );
      const manager = createManager(makeAgentProxyConfig(), client, {}, "primary", "own-bot");
      const update = async (state: APIVoiceState) => {
        cache.apply({ t: GatewayDispatchEvents.VoiceStateUpdate, d: state } as never);
        await manager.handleVoiceStateUpdate(state);
      };
      return { cache, client, manager, update };
    };

    it("reports ordered human transitions, ignores bots, and unsubscribes independently", async () => {
      const { manager, update } = fixture();
      const listener = vi.fn();
      const otherListener = vi.fn();
      const stop = manager.watchChannelOccupancy(room, listener);
      manager.watchChannelOccupancy(room, otherListener);
      try {
        await update(voiceState("helper-bot", "1001", true));
        await update(voiceState("own-bot", "1001"));
        expect(listener).not.toHaveBeenCalled();
        await update(voiceState("human-one", "1001"));
        await update(voiceState("human-two", "1001"));
        await update(voiceState("human-one", null));
        await update(voiceState("human-two", "1002"));
        expect(listener.mock.calls).toEqual([[{ occupied: true }], [{ occupied: false }]]);
        stop();
        await update(voiceState("human-one", "1001"));
        expect(listener).toHaveBeenCalledTimes(2);
        expect(otherListener.mock.calls).toEqual([
          [{ occupied: true }],
          [{ occupied: false }],
          [{ occupied: true }],
        ]);
      } finally {
        await manager.destroy();
      }
    });

    it.each(["Ready", "Resumed", "GuildCreate"] as const)(
      "waits for a known snapshot and reconciles on %s without conversational auto-join",
      async (event) => {
        const { cache, client, manager } = fixture();
        const listener = vi.fn();
        manager.watchChannelOccupancy(room, listener);
        expect(listener).not.toHaveBeenCalled();
        cache.apply({
          t: GatewayDispatchEvents.VoiceStateUpdate,
          d: voiceState("human-one", "1001"),
        } as never);
        const listeners = {
          Ready: new managerModule.DiscordVoiceReadyListener(manager),
          Resumed: new managerModule.DiscordVoiceResumedListener(manager),
          GuildCreate: new managerModule.DiscordVoiceGuildCreateListener(manager),
        };
        try {
          await listeners[event].handle({ id: "g1", unavailable: false } as never, client as never);
          expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
          cache.clear();
          await listeners[event].handle({ id: "g1", unavailable: false } as never, client as never);
          cache.apply({
            t: GatewayDispatchEvents.VoiceStateUpdate,
            d: voiceState("human-one", "1001"),
          } as never);
          await listeners[event].handle({ id: "g1", unavailable: false } as never, client as never);
          expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
          expect(manager.status()).toEqual([]);
        } finally {
          await manager.destroy();
        }
      },
    );

    it("emits occupied on subscription, survives transcript join/leave, and clears on destroy", async () => {
      const { manager, update } = fixture();
      await update(voiceState("human-one", "1001"));
      const listener = vi.fn();
      manager.watchChannelOccupancy(room, listener);
      expect(listener).toHaveBeenCalledExactlyOnceWith({ occupied: true });
      try {
        for (const sessionId of ["first", "second"]) {
          await manager.join(room, { transcripts: { sessionId, onUtterance: vi.fn() } });
          await manager.leave(room, { transcriptsSessionId: sessionId });
        }
        await update(voiceState("human-one", null));
        await update(voiceState("human-one", "1001"));
        expect(listener.mock.calls).toEqual([
          [{ occupied: true }],
          [{ occupied: false }],
          [{ occupied: true }],
        ]);
        expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      } finally {
        await manager.destroy();
      }
      await update(voiceState("human-one", null));
      manager.watchChannelOccupancy(room, listener);
      await update(voiceState("human-one", "1001"));
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it("returns the joined channel title without another channel lookup or starting realtime", async () => {
      const { discordVoiceTranscriptsSourceProvider, setDiscordTranscriptsVoiceManager } =
        await import("./transcripts-source.js");
      const { manager, client } = fixture();
      const channel = {
        id: "1001",
        guildId: "g1",
        guild: { id: "g1", name: "Guild One" },
        type: ChannelType.GuildVoice,
        name: "Planning room",
      };
      client.fetchChannel.mockResolvedValue(channel);
      setDiscordTranscriptsVoiceManager({ accountId: "primary", manager });
      try {
        const result = await discordVoiceTranscriptsSourceProvider.start?.({
          session: {
            sessionId: "notes",
            startedAt: "2026-09-02T10:00:00Z",
            source: { providerId: "discord-voice", accountId: "primary", ...room },
          },
          onUtterance: vi.fn(),
        });
        expect(result).toMatchObject({ ok: true, session: { title: "Planning room" } });
        expect(client.fetchChannel).toHaveBeenCalledExactlyOnceWith("1001");
        expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      } finally {
        setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: null });
        await manager.destroy();
      }
    });
  },
);
