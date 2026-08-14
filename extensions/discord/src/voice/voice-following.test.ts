import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expectDefined,
    expect,
    it,
    vi,
    ChannelType,
    createDefaultVoiceStates,
    createConnectionMock,
    getVoiceConnectionMock,
    joinVoiceChannelMock,
    agentCommandMock,
    realtimeSessionMock,
    updateVoiceStateMock,
    enqueueSystemEventMock,
    configureVoiceStateGateway,
    createClient,
    createManager,
    makeVoiceConfig,
    createFollowManager,
    expectConnectedStatus,
    getSessionEntry,
    updateVoiceState,
    handleSpeakingStart,
  }) => {
    it("enqueues the initial voice roster without speaking on its own", async () => {
      const client = createClient();
      configureVoiceStateGateway(client, createDefaultVoiceStates);
      const manager = createManager(undefined, client, {}, "default", "bot-user");

      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());

      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
      const [text, options] = enqueueSystemEventMock.mock.calls[0] ?? [];
      expect(text).toContain("Discord voice session roster");
      expect(text).toContain('display_name="Peter"');
      expect(text).toContain('display_name="Sam"');
      expect(text).not.toContain("Molty");
      expect(text).toContain("Do not respond to this event on its own");
      expect(options).toEqual({
        sessionKey: "discord:g1:c1",
        contextKey: "discord:voice-membership:default:g1",
        replace: true,
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
    });

    it("refreshes an active roster from a new gateway guild snapshot", async () => {
      const client = createClient();
      let voiceStates = [
        {
          guild_id: "g1",
          user_id: "u-before",
          channel_id: "1001",
          member: {
            nick: "Before",
            user: { id: "u-before", username: "before", global_name: "Before" },
          },
        },
      ];
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createManager(undefined, client);

      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      enqueueSystemEventMock.mockClear();

      voiceStates = [
        {
          guild_id: "g1",
          user_id: "u-after",
          channel_id: "1001",
          member: {
            nick: "After",
            user: { id: "u-after", username: "after", global_name: "After" },
          },
        },
      ];
      manager.refreshGuildRoster("g1");

      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      const refreshed = String(enqueueSystemEventMock.mock.calls[0]?.[0]);
      expect(refreshed).toContain("Discord voice session roster");
      expect(refreshed).toContain('user_id="u-after"');
      expect(refreshed).not.toContain('user_id="u-before"');
    });

    it("does not retain full membership state for very large voice rosters", async () => {
      const client = createClient();
      let voiceStates = Array.from({ length: 5_000 }, (_, index) => ({
        guild_id: "g1",
        user_id: `u-${String(index).padStart(4, "0")}`,
        channel_id: "1001",
      }));
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createManager(undefined, client);

      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());

      const text = String(enqueueSystemEventMock.mock.calls[0]?.[0]);
      expect(text.match(/^- user_id=/gm)).toHaveLength(20);
      expect(text).toContain("- 4980 more participant(s)");
      const entry = getSessionEntry(manager) as object;
      const tracker = (
        manager as unknown as {
          membership: {
            states: WeakMap<object, { inferredUserIds: Set<string> }>;
          };
        }
      ).membership;
      expect(tracker.states.get(entry)?.inferredUserIds.size).toBe(0);

      const overflowParticipant = expectDefined(
        voiceStates.at(-1),
        "overflow participant test invariant",
      );
      await manager.handleVoiceStateUpdate(
        { ...overflowParticipant, self_mute: true } as never,
        overflowParticipant as never,
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledOnce();

      voiceStates = voiceStates.slice(0, -1);
      await manager.handleVoiceStateUpdate(
        { ...overflowParticipant, channel_id: null } as never,
        overflowParticipant as never,
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain("A participant left");
      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain('user_id="u-4999"');
    });

    it("closes queued roster context when the voice session ends", async () => {
      const client = createClient();
      configureVoiceStateGateway(client, () => []);
      const manager = createManager(undefined, client);

      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2));

      const texts = enqueueSystemEventMock.mock.calls.map(([text]) => String(text));
      expect(texts[0]).toContain("Discord voice session roster");
      expect(texts[1]).toContain("Discord voice session ended");
      expect(texts[1]).toContain("prior roster or membership updates");
    });

    it("enqueues only real participant joins and leaves for the active voice channel", async () => {
      const client = createClient();
      let voiceStates: Array<Record<string, unknown>> = [
        {
          guild_id: "g1",
          user_id: "u-present",
          channel_id: "1001",
          member: {
            nick: "Present",
            user: { id: "u-present", username: "present", global_name: "Present" },
          },
        },
        { guild_id: "g1", user_id: "bot-user", channel_id: "1001" },
      ];
      configureVoiceStateGateway(client, () => voiceStates);
      client.fetchMember.mockImplementation(async (_guildId: string, userId: string) => ({
        nickname: userId === "u-present" ? "Present" : "New Friend",
        roles: [],
        user: { id: userId, username: userId, globalName: undefined, discriminator: "0" },
      }));
      const manager = createManager(undefined, client, {}, "default", "bot-user");
      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      enqueueSystemEventMock.mockClear();

      const joinedState = {
        guild_id: "g1",
        user_id: "u-new",
        channel_id: "1001",
        member: {
          nick: "New Friend",
          user: { id: "u-new", username: "new", global_name: "New Friend" },
        },
      };
      voiceStates = [...voiceStates, joinedState];
      await manager.handleVoiceStateUpdate(joinedState as never, null);

      await manager.handleVoiceStateUpdate(
        {
          guild_id: "g1",
          user_id: "u-new",
          channel_id: "1001",
          self_mute: true,
        } as never,
        joinedState as never,
      );

      voiceStates = voiceStates.filter((state) => state.user_id !== "u-new");
      await manager.handleVoiceStateUpdate(
        {
          guild_id: "g1",
          user_id: "u-new",
          channel_id: null,
          member: {
            nick: "New Friend",
            user: { id: "u-new", username: "new", global_name: "New Friend" },
          },
        } as never,
        joinedState as never,
      );

      await updateVoiceState(manager, "u-new", null);
      await updateVoiceState(manager, "u-elsewhere", "1002");
      await updateVoiceState(manager, "bot-user", "1001");

      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2));
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
      const texts = enqueueSystemEventMock.mock.calls.map(([text]) => String(text));
      expect(texts[0]).toContain("A participant joined");
      expect(texts[0]).toContain('display_name="New Friend"');
      expect(texts[0]).toContain("Current participants other than the agent after this update");
      expect(texts[0]).toContain('user_id="u-present"');
      expect(texts[0]).toContain("This roster snapshot supersedes prior voice membership context");
      expect(texts[1]).toContain("A participant left");
      expect(texts[1]).toContain('user_id="u-new"');
      expect(texts[1]).toContain("Current participants other than the agent after this update");
      expect(texts[1]).toContain('user_id="u-present"');
      expect(texts[1]).toContain("This roster snapshot supersedes prior voice membership context");
      for (const call of enqueueSystemEventMock.mock.calls) {
        expect(call[1]).toEqual({
          sessionKey: "discord:g1:c1",
          contextKey: "discord:voice-membership:default:g1",
          replace: true,
        });
      }
    });

    it("keeps every burst membership update self-contained with a current roster", async () => {
      const client = createClient();
      const voiceStates: Array<Record<string, unknown>> = [];
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createManager(undefined, client);
      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      enqueueSystemEventMock.mockClear();

      for (let index = 0; index < 25; index += 1) {
        const joinedState = {
          guild_id: "g1",
          user_id: `u-${String(index).padStart(2, "0")}`,
          channel_id: "1001",
        };
        voiceStates.push(joinedState);
        await manager.handleVoiceStateUpdate(joinedState as never, null);
      }
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledTimes(25));

      for (const [text, options] of enqueueSystemEventMock.mock.calls) {
        expect(String(text)).toContain(
          "Current participants other than the agent after this update",
        );
        expect(String(text)).toContain(
          "This roster snapshot supersedes prior voice membership context",
        );
        expect(options).toEqual({
          sessionKey: "discord:g1:c1",
          contextKey: "discord:voice-membership:default:g1",
          replace: true,
        });
      }
      const latest = String(enqueueSystemEventMock.mock.calls.at(-1)?.[0]);
      expect(latest).toContain('user_id="u-00"');
      expect(latest).toContain('user_id="u-19"');
      expect(latest).toContain("5 more participant(s)");
    });

    it("keeps cache-race speakers in the roster until their leave events", async () => {
      const client = createClient();
      configureVoiceStateGateway(client, () => []);
      const manager = createManager(undefined, client);
      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledOnce());
      enqueueSystemEventMock.mockClear();
      const entry = getSessionEntry(manager);

      await handleSpeakingStart(manager, entry, "u-raced-first");
      await handleSpeakingStart(manager, entry, "u-raced-second");
      await manager.handleVoiceStateUpdate({
        guild_id: "g1",
        user_id: "u-raced-second",
        channel_id: null,
        member: {
          nick: "Raced User",
          user: { id: "u-raced-second", username: "raced", global_name: "Raced User" },
        },
      } as never);
      await vi.waitFor(() => expect(enqueueSystemEventMock).toHaveBeenCalledTimes(3));

      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain(
        "Voice activity established that a participant is present",
      );
      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain(
        'user_id="u-raced-first"',
      );
      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain(
        'user_id="u-raced-second"',
      );
      expect(String(enqueueSystemEventMock.mock.calls[2]?.[0])).toContain("A participant left");
      expect(String(enqueueSystemEventMock.mock.calls[2]?.[0])).toContain(
        'user_id="u-raced-first"',
      );
    });

    it("publishes a membership change while startup label resolution is still pending", async () => {
      const client = createClient();
      const voiceStates: Array<Record<string, unknown>> = [
        { guild_id: "g1", user_id: "u-slow", channel_id: "1001" },
      ];
      configureVoiceStateGateway(client, () => voiceStates);
      let resolveMember: (value: unknown) => void = () => {};
      client.fetchMember.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveMember = resolve;
          }),
      );
      const manager = createManager(undefined, client);
      await manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(client.fetchMember).toHaveBeenCalledOnce());

      const joinedState = {
        guild_id: "g1",
        user_id: "u-new",
        channel_id: "1001",
        member: {
          nick: "New Friend",
          user: { id: "u-new", username: "new", global_name: "New Friend" },
        },
      };
      voiceStates.push(joinedState);
      await manager.handleVoiceStateUpdate(joinedState as never, null);

      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
      expect(String(enqueueSystemEventMock.mock.calls[1]?.[0])).toContain("A participant joined");
      resolveMember({
        nickname: "Slow User",
        roles: [],
        user: {
          id: "u-slow",
          username: "slow",
          globalName: "Slow User",
          discriminator: "0",
        },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    });

    it("keeps joins and followed-user moves independent from roster label resolution", async () => {
      const client = createClient();
      configureVoiceStateGateway(client, (_guildId: unknown, channelId: unknown) =>
        channelId === "1001" ? [{ guild_id: "g1", user_id: "u-slow", channel_id: "1001" }] : [],
      );
      let resolveMember: (value: unknown) => void = () => {};
      client.fetchMember.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveMember = resolve;
          }),
      );
      const manager = createFollowManager(
        {
          allowedChannels: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g1", channelId: "1002" },
          ],
        },
        client,
      );

      const result = await manager.join({ guildId: "g1", channelId: "1001" });
      expect(result.ok).toBe(true);
      await vi.waitFor(() => expect(client.fetchMember).toHaveBeenCalledOnce());

      await manager.handleVoiceStateUpdate(
        {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1002",
        } as never,
        {
          guild_id: "g1",
          user_id: "u-owner",
          channel_id: "1001",
        } as never,
      );

      expectConnectedStatus(manager, "1002");
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(4);
      expect(String(enqueueSystemEventMock.mock.calls[2]?.[0])).toContain(
        "Discord voice session ended",
      );
      expect(String(enqueueSystemEventMock.mock.calls[3]?.[0])).toContain(
        "Discord voice session roster",
      );
      resolveMember({
        nickname: "Slow User",
        roles: [],
        user: {
          id: "u-slow",
          username: "slow",
          globalName: "Slow User",
          discriminator: "0",
        },
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(enqueueSystemEventMock).toHaveBeenCalledTimes(4);

      const texts = enqueueSystemEventMock.mock.calls.map(([text]) => String(text));
      expect(texts[0]).toContain("Discord voice session roster");
      expect(texts[0]).toContain('channel_id="1001"');
      expect(texts[1]).toContain("A participant left");
      expect(texts[2]).toContain("Discord voice session ended");
      expect(texts[2]).toContain('channel_id="1001"');
      expect(texts[3]).toContain("Discord voice session roster");
      expect(texts[3]).toContain('channel_id="1002"');
      expect(texts.slice(2).some((text) => text.includes('user_id="u-slow"'))).toBe(false);
    });

    it("follows configured users into voice channels", async () => {
      const manager = createFollowManager({ followUsers: ["discord:u-owner"] });

      await updateVoiceState(manager, "u-owner", "1001");

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expectConnectedStatus(manager, "1001");
    });

    it("does not follow configured users when followUsersEnabled is false", async () => {
      const manager = createFollowManager({ followUsersEnabled: false });

      await updateVoiceState(manager, "u-owner", "1001");

      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
      expect(manager.status()).toEqual([]);
    });

    it("disconnects stale bot voice state when followed users are absent during reconciliation", async () => {
      const client = createClient();
      client.rest.get
        .mockRejectedValueOnce(new Error("Unknown Voice State"))
        .mockResolvedValueOnce({
          guild_id: "g1",
          user_id: "bot-user",
          channel_id: "1001",
        });
      const manager = createFollowManager({}, client, { guilds: { g1: {} } }, "bot-user");

      await manager.autoJoin();
      await manager.destroy();

      expect(updateVoiceStateMock).toHaveBeenCalledWith({
        guild_id: "g1",
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      });
    });

    it("moves with configured followed users", async () => {
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");
      await updateVoiceState(manager, "u-owner", "1002");

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expectConnectedStatus(manager, "1002");
    });

    it("preserves follow ownership when a bot voice move rebuilds the session", async () => {
      const manager = createFollowManager({}, undefined, {}, "bot-user");

      await updateVoiceState(manager, "u-owner", "1001");
      await updateVoiceState(manager, "bot-user", "1002");
      await updateVoiceState(manager, "u-owner", null);

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expect(manager.status()).toEqual([]);
    });

    it("leaves when a followed user disconnects", async () => {
      const manager = createFollowManager();

      await updateVoiceState(manager, "u-owner", "1001");
      await updateVoiceState(manager, "u-owner", null);

      expect(manager.status()).toEqual([]);
    });

    it("hands off to another followed user when the active followed user disconnects", async () => {
      const manager = createFollowManager({
        allowedChannels: [
          { guildId: "g1", channelId: "1001" },
          { guildId: "g1", channelId: "1002" },
        ],
        followUsers: ["u-owner", "u-backup"],
      });

      await updateVoiceState(manager, "u-backup", "1002");
      await updateVoiceState(manager, "u-owner", "1001");
      await updateVoiceState(manager, "u-owner", null);

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
      expectConnectedStatus(manager, "1002");
    });

    it("leaves the stale followed channel when handoff to another followed user fails", async () => {
      const client = createClient();
      let backupFetches = 0;
      client.fetchChannel.mockImplementation(async (channelId: string) => {
        if (channelId === "1002") {
          backupFetches += 1;
          if (backupFetches > 1) {
            return null;
          }
        }
        return {
          id: channelId,
          guildId: "g1",
          guild: { id: "g1", name: "Guild One" },
          type: ChannelType.GuildVoice,
        };
      });
      const manager = createFollowManager(
        {
          allowedChannels: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g1", channelId: "1002" },
          ],
          followUsers: ["u-owner", "u-backup"],
        },
        client,
      );

      await updateVoiceState(manager, "u-backup", "1002");
      await updateVoiceState(manager, "u-owner", "1001");
      await updateVoiceState(manager, "u-owner", null);

      expect(manager.status()).toEqual([]);
    });

    it("does not follow configured users into disallowed channels", async () => {
      const manager = createFollowManager({
        allowedChannels: [{ guildId: "g1", channelId: "1001" }],
      });

      await updateVoiceState(manager, "u-owner", "1002");

      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
      expect(manager.status()).toEqual([]);
    });

    it("bounds followed user reconciliation REST lookups", async () => {
      const client = createClient();
      client.rest.get.mockRejectedValue(new Error("Unknown Voice State"));
      const guilds = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`g${index + 1}`, {}]),
      );
      const manager = createFollowManager(
        { followUsers: ["u1", "u2", "u3", "u4", "u5"] },
        client,
        { guilds },
        "bot-user",
      );

      await manager.autoJoin();
      await manager.destroy();

      expect(client.rest.get).toHaveBeenCalledTimes(24);
    });

    it("keeps followed voice state when reconciliation hits a transient REST failure", async () => {
      const client = createClient();
      const manager = createFollowManager({}, client, { guilds: { g1: {} } });

      await updateVoiceState(manager, "u-owner", "1001");
      client.rest.get.mockRejectedValue(new Error("Discord API failed (500): fetch failed"));

      await manager.autoJoin();

      expectConnectedStatus(manager, "1001");
      expect(updateVoiceStateMock).not.toHaveBeenCalled();
      await manager.destroy();
    });

    it("does not reconnect from an in-flight followed user reconciliation after destroy", async () => {
      const client = createClient();
      let resolveVoiceState: (state: unknown) => void = () => {};
      client.rest.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVoiceState = resolve;
          }),
      );
      const manager = createFollowManager({}, client, { guilds: { g1: {} } });

      const autoJoinPromise = manager.autoJoin();
      await vi.waitFor(() => {
        expect(client.rest.get).toHaveBeenCalled();
      });
      await manager.destroy();
      resolveVoiceState({ guild_id: "g1", user_id: "u-owner", channel_id: "1001" });
      await autoJoinPromise;

      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
      expect(manager.status()).toEqual([]);
    });

    it("pages followed user reconciliation when the user list exceeds the REST budget", async () => {
      const client = createClient();
      client.rest.get.mockImplementation(async (path: string) => {
        if (path.endsWith("/u39")) {
          return { guild_id: "g1", user_id: "u39", channel_id: "1001" };
        }
        throw new Error("Unknown Voice State");
      });
      const manager = createFollowManager(
        { followUsers: Array.from({ length: 40 }, (_, index) => `u${index + 1}`) },
        client,
        { guilds: { g1: {} } },
        "bot-user",
      );

      await manager.autoJoin();
      expect(client.rest.get).toHaveBeenCalledTimes(31);
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();

      await manager.autoJoin();
      await manager.destroy();

      expect(client.rest.get).toHaveBeenCalledTimes(62);
      expect(joinVoiceChannelMock).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: "g1", channelId: "1001" }),
      );
    });

    it("rotates followed user reconciliation guilds when a user page consumes the REST budget", async () => {
      const client = createClient();
      client.fetchChannel.mockImplementation(async (channelId: string) => ({
        id: channelId,
        guildId: "g2",
        guild: { id: "g2", name: "Guild Two" },
        type: ChannelType.GuildVoice,
      }));
      client.rest.get.mockImplementation(async (path: string) => {
        if (path.includes("/guilds/g2/") && path.endsWith("/u1")) {
          return { guild_id: "g2", user_id: "u1", channel_id: "2001" };
        }
        throw new Error("Unknown Voice State");
      });
      const manager = createFollowManager(
        { followUsers: Array.from({ length: 40 }, (_, index) => `u${index + 1}`) },
        client,
        { guilds: { g1: {}, g2: {} } },
        "bot-user",
      );

      await manager.autoJoin();
      expect(client.rest.get).toHaveBeenCalledTimes(31);
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();

      await manager.autoJoin();
      await manager.destroy();

      expect(client.rest.get).toHaveBeenCalledTimes(62);
      expect(client.rest.get.mock.calls.slice(0, 31)).toEqual(
        expect.arrayContaining([[expect.stringContaining("/guilds/g1/voice-states/u1")]]),
      );
      expect(client.rest.get.mock.calls.slice(31)).toEqual(
        expect.arrayContaining([[expect.stringContaining("/guilds/g2/voice-states/u1")]]),
      );
      expect(joinVoiceChannelMock).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: "g2", channelId: "2001" }),
      );
    });

    it("rotates followed user reconciliation bot voice checks when only some fit the REST budget", async () => {
      const client = createClient();
      client.rest.get.mockImplementation(async (path: string) => {
        if (path.includes("/guilds/g3/") && path.endsWith("/bot-user")) {
          return { guild_id: "g3", user_id: "bot-user", channel_id: "3001" };
        }
        throw new Error("Unknown Voice State");
      });
      const manager = createFollowManager(
        { followUsers: Array.from({ length: 10 }, (_, index) => `u${index + 1}`) },
        client,
        { guilds: { g1: {}, g2: {}, g3: {} } },
        "bot-user",
      );

      await manager.autoJoin();
      expect(client.rest.get).toHaveBeenCalledTimes(32);
      expect(updateVoiceStateMock).not.toHaveBeenCalled();

      await manager.autoJoin();
      await manager.destroy();

      expect(client.rest.get).toHaveBeenCalledTimes(64);
      expect(updateVoiceStateMock).toHaveBeenCalledWith({
        guild_id: "g3",
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      });
    });

    it("treats an empty allowed voice channel list as deny-all", async () => {
      const manager = createManager(makeVoiceConfig({ allowedChannels: [] }));

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(false);
      expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    });

    it("leaves and rejoins the configured target when Discord moves the bot outside allowed voice channels", async () => {
      const manager = createManager(
        makeVoiceConfig({
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
          allowedChannels: [{ guildId: "g1", channelId: "1001" }],
        }),
        undefined,
        {},
        "default",
        "bot-user",
      );
      await manager.join({ guildId: "g1", channelId: "1001" });

      await updateVoiceState(manager, "bot-user", "1002");

      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      expectConnectedStatus(manager, "1001");
    });

    it("skips destroying stale tracked voice connections that are already destroyed", async () => {
      const staleConnection = createConnectionMock();
      staleConnection.state.status = "destroyed";
      staleConnection.destroy.mockImplementation(() => {
        throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
      });
      getVoiceConnectionMock.mockReturnValueOnce(staleConnection);
      joinVoiceChannelMock.mockReturnValueOnce(createConnectionMock());
      const manager = createManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });
      expect(result.ok).toBe(true);

      expect(staleConnection.destroy).not.toHaveBeenCalled();
    });

    it("skips destroying an already destroyed voice connection on leave", async () => {
      const connection = createConnectionMock();
      connection.destroy.mockImplementation(() => {
        throw new Error("Cannot destroy VoiceConnection - it has already been destroyed");
      });
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });
      connection.state.status = "destroyed";

      const result = await manager.leave({ guildId: "g1" });
      expect(result.ok).toBe(true);
      expect(connection.destroy).not.toHaveBeenCalled();
    });
  },
);
