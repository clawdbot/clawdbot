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

    it.each([
      {
        label: "empty to occupied",
        initialOccupied: false,
        replacementOccupied: true,
        eventsAfterReplacement: ["occupied"],
        eventsAfterToggle: ["occupied", "empty"],
        ending: "stop",
      },
      {
        label: "occupied to empty",
        initialOccupied: true,
        replacementOccupied: false,
        eventsAfterReplacement: ["occupied", "empty"],
        eventsAfterToggle: ["occupied", "empty", "occupied"],
        ending: "abort",
      },
      {
        label: "still occupied",
        initialOccupied: true,
        replacementOccupied: true,
        eventsAfterReplacement: ["occupied"],
        eventsAfterToggle: ["occupied", "empty"],
        ending: "stop",
      },
    ])(
      "keeps transcript occupancy watching after account restart: $label",
      async ({
        initialOccupied,
        replacementOccupied,
        eventsAfterReplacement,
        eventsAfterToggle,
        ending,
      }) => {
        const { discordVoiceTranscriptsSourceProvider, setDiscordTranscriptsVoiceManager } =
          await import("./transcripts-source.js");
        const original = fixture();
        const replacement = fixture();
        const later = fixture();
        const watchReplacement = vi.spyOn(replacement.manager, "watchChannelOccupancy");
        const watchLater = vi.spyOn(later.manager, "watchChannelOccupancy");
        const controller = new AbortController();
        const events: string[] = [];
        let stop: (() => void) | undefined;
        try {
          await original.update(voiceState("human", initialOccupied ? "1001" : "1002"));
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: original.manager });
          const result = await discordVoiceTranscriptsSourceProvider.watchOccupancy?.({
            source: { providerId: "discord-voice", accountId: "primary", ...room },
            abortSignal: controller.signal,
            onOccupied: () => {
              events.push("occupied");
            },
            onEmpty: () => {
              events.push("empty");
            },
          });
          if (!result?.ok) {
            throw new Error("expected occupancy subscription");
          }
          stop = result.value.stop;
          expect(events).toEqual(initialOccupied ? ["occupied"] : []);

          await original.manager.destroy();
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: null });
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: replacement.manager });
          // An unavailable manager or unknown replacement snapshot is not an empty room.
          expect(events).toEqual(initialOccupied ? ["occupied"] : []);
          await replacement.update(voiceState("human", replacementOccupied ? "1001" : "1002"));
          expect(events).toEqual(eventsAfterReplacement);
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: replacement.manager });
          expect(watchReplacement).toHaveBeenCalledOnce();
          await replacement.update(voiceState("human", replacementOccupied ? "1002" : "1001"));
          expect(events).toEqual(eventsAfterToggle);

          if (ending === "abort") {
            controller.abort();
          } else {
            stop();
          }
          stop();
          await replacement.update(voiceState("human", replacementOccupied ? "1001" : "1002"));
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: later.manager });
          await later.update(voiceState("human", "1001"));
          expect(events).toEqual(eventsAfterToggle);
          expect(watchLater).not.toHaveBeenCalled();
        } finally {
          stop?.();
          setDiscordTranscriptsVoiceManager({ accountId: "primary", manager: null });
          await original.manager.destroy();
          await replacement.manager.destroy();
          await later.manager.destroy();
        }
      },
    );

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
