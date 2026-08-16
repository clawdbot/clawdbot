import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createVoiceCaptureState,
    createVoiceReceiveRecoveryState,
    lastMockCall,
    createDefaultVoiceStates,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    createAudioResourceMock,
    agentCommandMock,
    resolveVoiceIngressWithParticipantsMock,
    transcribeAudioFileMock,
    prepareTtsRequestMock,
    textToSpeechStreamMock,
    textToSpeechMock,
    logVerboseMock,
    controlRealtimeVoiceAgentRunMock,
    realtimeSessionMock,
    decodeOpusStreamMock,
    managerModule,
    realtimeModule,
    segmentModule,
    configureVoiceStateGateway,
    createClient,
    createClientWithMember,
    createRuntime,
    createManager,
    makeVoiceConfig,
    createFollowManager,
    getSessionEntry,
    beginSpeakerTurn,
    lastAgentCommandArgs,
    lastAgentCommandToolNames,
    createJoinedAgentProxyFixture,
    lastTtsArgs,
    lastTtsStreamArgs,
    expectUserMessageNotIncludes,
    processVoiceSegment,
    updateVoiceState,
    handleSpeakingStart,
  }) => {
    it("composes join, audio ingress, agent dispatch, playback, and leave", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      decodeOpusStreamMock.mockResolvedValueOnce(Buffer.alloc(96_000));
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "composed voice reply" }] });
      const stream = {
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
        destroyed: false,
        async *[Symbol.asyncIterator]() {},
      };
      connection.receiver.subscribe.mockReturnValueOnce(stream);
      const manager = createManager({
        groupPolicy: "open",
        allowFrom: ["discord:u-speaker"],
        voice: { enabled: true, mode: "stt-tts" },
      });

      expect((await manager.join({ guildId: "g1", channelId: "1001" })).ok).toBe(true);
      const entry = getSessionEntry(manager);
      await handleSpeakingStart(manager, entry, "u-speaker");
      await entry.processingQueue;
      await entry.playbackQueue;

      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        "u-speaker",
        expect.objectContaining({ end: { behavior: "Manual" } }),
      );
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(entry.player.play).toHaveBeenCalledOnce();
      expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);
      expect(manager.status()).toEqual([]);
    });

    it.each([
      {
        name: "withholds owner-only tools from account allowlisted voice speakers",
        userId: "u-owner",
        client: () => createClientWithMember("u-owner", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client),
        expectedOwner: false,
        toolNames: { include: ["exec"], exclude: ["gateway", "nodes", "openclaw"] },
      },
      ...["*", " * "].map((allowFrom, index) => ({
        name:
          index === 0
            ? "admits account wildcard voice speakers without granting owner authority"
            : "normalizes account wildcard voice admission without granting owner authority",
        userId: "u-guest",
        client: () => createClientWithMember("u-guest", "Guest", "4321"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            { groupPolicy: "allowlist", allowFrom: [allowFrom], guilds: { g1: {} } },
            client,
          ),
        expectedOwner: false,
      })),
      {
        name: "keeps owner-only tools for commands.ownerAllowFrom voice speakers",
        userId: "100000000000000001",
        client: () => createClientWithMember("100000000000000001", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager({ groupPolicy: "open", dmPolicy: "disabled" }, client, {
            commands: { ownerAllowFrom: ["discord:100000000000000001"] },
          }),
        expectedOwner: true,
        toolNames: { include: ["gateway", "nodes", "openclaw"], exclude: [] },
      },
      {
        name: "admits the Discord command-owner wildcard without owner voice authority",
        userId: "u-owner",
        client: () => createClientWithMember("u-owner", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager({ groupPolicy: "open", dmPolicy: "disabled" }, client, {
            commands: { ownerAllowFrom: ["discord:*"] },
          }),
        expectedOwner: false,
        toolNames: { include: ["exec"], exclude: ["gateway", "nodes", "openclaw"] },
      },
      {
        name: "does not use another provider's command owners for Discord voice",
        userId: "u-guest",
        client: () => createClientWithMember("u-guest", "Guest", "4321"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager({ groupPolicy: "open", dmPolicy: "disabled" }, client, {
            commands: { ownerAllowFrom: ["telegram:u-guest"] },
          }),
        expectedOwner: null,
      },
      {
        name: "does not treat followed voice users as owners",
        userId: "u-followed",
        client: () => createClientWithMember("u-followed", "Followed", "4321", "Followed Guest"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            {
              groupPolicy: "open",
              dmPolicy: "disabled",
              voice: { enabled: true, followUsers: ["u-followed"] },
            },
            client,
          ),
        expectedOwner: null,
      },
      {
        name: "accepts open-policy voice speakers",
        userId: "u-guest",
        client: () => createClientWithMember("u-guest", "Guest", "4321"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client),
      },
    ])(
      "$name",
      async ({ client: createScenarioClient, manager: createScenarioManager, ...scenario }) => {
        const client = createScenarioClient();
        await processVoiceSegment(createScenarioManager(client), scenario.userId);

        if (scenario.expectedOwner === null) {
          expect(agentCommandMock).not.toHaveBeenCalled();
        } else if (scenario.expectedOwner !== undefined) {
          expect(agentCommandMock).toHaveBeenCalledWith(
            expect.objectContaining({ senderIsOwner: scenario.expectedOwner }),
            expect.anything(),
          );
        }
        if ("toolNames" in scenario && scenario.toolNames) {
          const toolNames = lastAgentCommandToolNames();
          scenario.toolNames.include.forEach((name) => expect(toolNames).toContain(name));
          scenario.toolNames.exclude.forEach((name) => expect(toolNames).not.toContain(name));
        }
      },
    );

    it("routes active-run STT/TTS transcripts to voice control before agent turns", async () => {
      controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
        ok: true,
        mode: "steer",
        sessionKey: "discord:g1:1001",
        sessionId: "embedded-active",
        active: true,
        queued: true,
        target: "embedded_run",
        message: "Got it. I steered the active run.",
        speak: true,
        show: true,
        suppress: false,
      });
      transcribeAudioFileMock.mockResolvedValueOnce({ text: "use the smaller implementation" });
      const client = createClientWithMember("u-owner", "Owner", "1234");
      const discordConfig: ConstructorParameters<
        typeof managerModule.DiscordVoiceManager
      >[0]["discordConfig"] = { groupPolicy: "open", allowFrom: ["discord:u-owner"] };
      const manager = createManager(discordConfig, client);
      const enqueuePlayback = vi.fn();
      const speakerContext = (
        manager as unknown as {
          speakerContext: Parameters<
            typeof segmentModule.processDiscordVoiceSegment
          >[0]["speakerContext"];
        }
      ).speakerContext;

      await segmentModule.processDiscordVoiceSegment({
        accountId: "default",
        entry: {
          guildId: "g1",
          channelId: "1001",
          sessionChannelId: "1001",
          voiceSessionKey: "discord:g1:1001",
          route: { sessionKey: "discord:g1:1001", agentId: "agent-1" },
          connection: createConnectionMock(),
          player: createAudioPlayerMock(),
          sessionLifecycle: { status: "active" },
          playbackQueue: Promise.resolve(),
          processingQueue: Promise.resolve(),
          capture: createVoiceCaptureState(),
          receiveRecovery: createVoiceReceiveRecoveryState(),
          isStopped: () => false,
          stop: vi.fn(),
        } as unknown as Parameters<typeof segmentModule.processDiscordVoiceSegment>[0]["entry"],
        wavPath: "/tmp/test.wav",
        userId: "u-owner",
        durationSeconds: 1.2,
        cfg: {},
        discordConfig,
        admissionAllowFrom: ["discord:u-owner"],
        runtime: createRuntime(),
        fetchGuildName: async () => "Guild One",
        speakerContext,
        enqueuePlayback,
      });

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:1001",
        text: "use the smaller implementation",
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(lastTtsArgs().text).toBe("Got it. I steered the active run.");
      expect(enqueuePlayback).toHaveBeenCalledTimes(1);
    });

    it("passes configured model override to agent command in voice flow", async () => {
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Guest Nick",
        user: {
          id: "u-guest",
          username: "guest",
          globalName: "Guest",
          discriminator: "4321",
        },
      });
      const manager = createManager(
        {
          groupPolicy: "open",
          allowFrom: ["discord:u-guest"],
          voice: {
            model: "openai/gpt-5.4-mini",
          },
        },
        client,
        {},
      );
      await processVoiceSegment(manager, "u-guest");

      expect(agentCommandMock, JSON.stringify(logVerboseMock.mock.calls)).toHaveBeenCalled();
      const commandArgs = lastAgentCommandArgs() as
        | { allowModelOverride?: boolean; model?: string }
        | undefined;

      expect(commandArgs?.allowModelOverride).toBe(true);
      expect(commandArgs?.model).toBe("openai/gpt-5.4-mini");
    });

    it("runs voice replies under Discord voice output policy", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-voice-"));
      const audioPath = path.join(tempDir, "reply.mp3");
      await fs.writeFile(audioPath, "voice");
      textToSpeechMock.mockResolvedValueOnce({ success: true, audioPath });
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "hello back" }],
      } as never);

      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        { groupPolicy: "open", allowFrom: ["discord:u-guest"] },
        client,
        {},
      );
      try {
        await processVoiceSegment(manager, "u-guest");
        await vi.waitFor(async () => {
          const exists = await fs.access(audioPath).then(
            () => true,
            () => false,
          );
          expect(exists).toBe(false);
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }

      const commandArgs = lastAgentCommandArgs() as
        | { message?: string; messageChannel?: string; messageProvider?: string }
        | undefined;

      expect(commandArgs?.messageChannel).toBe("discord");
      expect(commandArgs?.messageProvider).toBe("discord-voice");
      expect(commandArgs?.message).toContain("Do not call the tts tool");
      expect(commandArgs?.message).toContain("repair obvious transcription artifacts");
      expect(prepareTtsRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: "hello back" }),
      );
      expect(lastTtsArgs().channel).toBe("discord");
      expect(lastTtsArgs().text).toBe("hello back");
    });

    it("logs a bounded inbound transcript preview for voice debugging", async () => {
      transcribeAudioFileMock.mockResolvedValueOnce({
        text: `hello from voice\n\n${"x".repeat(700)}`,
      });
      const client = createClientWithMember("u-debug", "Debug", "0001", "Debug Speaker");
      const manager = createManager(
        { groupPolicy: "open", allowFrom: ["discord:u-debug"] },
        client,
        {},
      );

      await processVoiceSegment(manager, "u-debug");

      const transcriptLog = logVerboseMock.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("transcript from Debug Speaker (u-debug)"));
      expect(transcriptLog).toContain("hello from voice ");
      expect(transcriptLog).not.toContain("\n");
      expect(transcriptLog?.length).toBeLessThan(650);
    });

    it("plays streaming TTS audio before falling back to a synthesized file", async () => {
      const release = vi.fn(async () => undefined);
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
      } as never);

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
      const audioResourceInput = lastMockCall(
        createAudioResourceMock as unknown as MockCallSource,
        "audio resource",
      )[0];
      if (audioResourceInput === undefined) {
        throw new Error("expected Discord audio resource input");
      }
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it("releases late TTS without playback after the voice session leaves", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      decodeOpusStreamMock.mockResolvedValueOnce(Buffer.alloc(96_000));
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "late voice reply" }] });
      const release = vi.fn(async () => undefined);
      let resolveStream!: (value: unknown) => void;
      textToSpeechStreamMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
      );
      connection.receiver.subscribe.mockReturnValueOnce({
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
        destroyed: false,
        async *[Symbol.asyncIterator]() {},
      });
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);

      const speaking = handleSpeakingStart(manager, entry, "u-speaker");
      await vi.waitFor(() => expect(textToSpeechStreamMock).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      resolveStream({
        success: true,
        audioStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        release,
      });
      await speaking;
      await entry.processingQueue;
      await entry.playbackQueue;

      expect(entry.player.play).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("passes per-channel system prompt context to voice agent runs", async () => {
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        {
          groupPolicy: "open",
          allowFrom: ["discord:u-guest"],
          guilds: {
            g1: {
              channels: {
                "1001": {
                  systemPrompt: "  Use short voice replies.  ",
                },
              },
            },
          },
        },
        client,
        {},
      );
      await processVoiceSegment(manager, "u-guest");

      const commandArgs = lastAgentCommandArgs() as { extraSystemPrompt?: string } | undefined;

      expect(commandArgs?.extraSystemPrompt).toBe("Use short voice replies.");
    });

    it("passes the live voice participant roster to agent turns", async () => {
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Peter",
        roles: [],
        user: {
          id: "u-owner",
          username: "peter",
          globalName: "Peter",
          discriminator: "0",
        },
      });
      configureVoiceStateGateway(client, createDefaultVoiceStates);
      const manager = createManager(
        {
          groupPolicy: "open",
          allowFrom: ["discord:u-owner"],
          guilds: {
            g1: {
              channels: {
                "1001": { systemPrompt: "Use short voice replies." },
              },
            },
          },
        },
        client,
        {},
        "default",
        "bot-user",
      );

      await processVoiceSegment(manager, "u-owner");

      const commandArgs = lastAgentCommandArgs() as { extraSystemPrompt?: string } | undefined;
      expect(commandArgs?.extraSystemPrompt).toContain("Use short voice replies.");
      expect(commandArgs?.extraSystemPrompt).toContain('display_name="Peter"');
      expect(commandArgs?.extraSystemPrompt).toContain('display_name="Sam"');
      expect(commandArgs?.extraSystemPrompt).not.toContain("Molty");
      expect(commandArgs?.extraSystemPrompt).toContain(
        "Use this roster when asked who is currently present",
      );
    });

    it("reuses speaker context cache for repeated segments from the same speaker", async () => {
      const client = createClientWithMember("u-cache", "Cache", "1111", "Cached Speaker");
      const manager = createManager({ allowFrom: ["discord:u-cache"] }, client);
      const runSegment = async () => await processVoiceSegment(manager, "u-cache");

      await runSegment();
      await runSegment();

      expect(client.fetchMember).toHaveBeenCalledTimes(3);
    });

    it("persists full speaker context in cache writes", async () => {
      const client = createClient();
      client.fetchMember.mockResolvedValue({
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: {
          id: "u-role",
          username: "role",
          globalName: "Role",
          discriminator: "2222",
        },
      });
      const manager = createManager(
        {
          groupPolicy: "allowlist",
          guilds: {
            g1: {
              channels: {
                "1001": {
                  roles: ["role:role-voice"],
                },
              },
            },
          },
        },
        client,
      );

      await processVoiceSegment(manager, "u-role");

      const cache = (
        manager as unknown as {
          speakerContext: {
            cache: Map<
              string,
              {
                id?: string;
                label: string;
                name?: string;
                tag?: string;
                senderIsOwner: boolean;
                expiresAt: number;
              }
            >;
          };
        }
      ).speakerContext.cache;
      const cached = cache.get("g1:u-role");

      expect(cached?.id).toBe("u-role");
      expect(cached?.label).toBe("Role Speaker");
      expect(agentCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ senderIsOwner: false }),
        expect.anything(),
      );
    });

    it("re-fetches member roles for repeated voice auth checks", async () => {
      const client = createClient();
      client.fetchMember
        .mockResolvedValueOnce({
          nickname: "Role Speaker",
          roles: ["role-voice"],
          user: {
            id: "u-role",
            username: "role",
            globalName: "Role",
            discriminator: "2222",
          },
        })
        .mockResolvedValueOnce({
          nickname: "Role Speaker",
          roles: ["role-voice"],
          user: {
            id: "u-role",
            username: "role",
            globalName: "Role",
            discriminator: "2222",
          },
        })
        .mockResolvedValueOnce({
          nickname: "Role Speaker",
          roles: [],
          user: {
            id: "u-role",
            username: "role",
            globalName: "Role",
            discriminator: "2222",
          },
        })
        .mockResolvedValue({
          nickname: "Role Speaker",
          roles: [],
          user: {
            id: "u-role",
            username: "role",
            globalName: "Role",
            discriminator: "2222",
          },
        });
      const manager = createManager(
        {
          groupPolicy: "allowlist",
          guilds: {
            g1: {
              channels: {
                "1001": {
                  roles: ["role:role-voice"],
                },
              },
            },
          },
        },
        client,
      );

      await processVoiceSegment(manager, "u-role");
      await processVoiceSegment(manager, "u-role");

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(client.fetchMember).toHaveBeenCalledTimes(3);
    });

    it("fetches guild metadata before allowlist checks when the session lacks a guild name", async () => {
      const client = createClient();
      client.fetchGuild.mockResolvedValue({ id: "g1", name: "Guild One" });
      client.fetchMember.mockResolvedValue({
        nickname: "Owner Nick",
        user: {
          id: "u-owner",
          username: "owner",
          globalName: "Owner",
          discriminator: "1234",
        },
      });
      const manager = createManager(
        {
          groupPolicy: "allowlist",
          guilds: {
            "guild-one": {
              channels: {
                "*": {
                  users: ["discord:u-owner"],
                },
              },
            },
          },
        },
        client,
      );

      await processVoiceSegment(manager, "u-owner");

      expect(client.fetchGuild).toHaveBeenCalledWith("g1");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    it("leave cancels a pending join before that generation can publish", async () => {
      const connection = createConnectionMock();
      let resolveReady!: () => void;
      const ready = new Promise<undefined>((resolve) => {
        resolveReady = () => resolve(undefined);
      });
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      entersStateMock.mockImplementationOnce(async () => ready);
      const manager = createManager();

      const join = manager.join({ guildId: "g1", channelId: "1001" });
      await vi.waitFor(() => expect(entersStateMock).toHaveBeenCalledOnce());
      const leave = await manager.leave({ guildId: "g1" });
      resolveReady();
      const joined = await join;

      expect(leave.ok).toBe(true);
      expect(joined.ok).toBe(false);
      expect(manager.status()).toEqual([]);
      expect(connection.destroy).toHaveBeenCalledOnce();
    });

    it("does not subscribe a receiver after stop wins speaker authorization", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const client = createClient();
      let resolveAuthorization!: () => void;
      const manager = createManager(
        {
          groupPolicy: "open",
          voice: { enabled: true, mode: "bidi", realtime: { provider: "openai" } },
        },
        client,
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      resolveVoiceIngressWithParticipantsMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAuthorization = () =>
            resolve({ senderIsOwner: true, speakerLabel: "Allowed Speaker" });
        }),
      );
      const entry = getSessionEntry(manager);

      const speaking = handleSpeakingStart(manager, entry, "u-speaker");
      await vi.waitFor(() =>
        expect(resolveVoiceIngressWithParticipantsMock).toHaveBeenCalledOnce(),
      );
      await manager.leave({ guildId: "g1" });
      resolveAuthorization();
      await speaking;

      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it("does not run STT or playback after leave wins decoding", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      let resolveDecode!: (audio: Buffer) => void;
      decodeOpusStreamMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDecode = resolve;
        }),
      );
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const stream = {
        on: vi.fn(),
        off: vi.fn(),
        destroy: vi.fn(),
        destroyed: false,
        async *[Symbol.asyncIterator]() {},
      };
      connection.receiver.subscribe.mockReturnValueOnce(stream);

      const speaking = handleSpeakingStart(manager, entry, "u-speaker");
      await vi.waitFor(() => expect(decodeOpusStreamMock).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      resolveDecode(Buffer.alloc(96_000));
      await speaking;
      await entry.processingQueue;

      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(entry.player.play).not.toHaveBeenCalled();
    });

    it("keeps followed-user voice state last-event-wins across a pending join", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      let resolveReady!: () => void;
      entersStateMock.mockImplementationOnce(
        async () =>
          await new Promise<undefined>((resolve) => {
            resolveReady = () => resolve(undefined);
          }),
      );
      const manager = createFollowManager();

      const joining = updateVoiceState(manager, "u-owner", "1001");
      await vi.waitFor(() => expect(entersStateMock).toHaveBeenCalledOnce());
      await updateVoiceState(manager, "u-owner", null);
      resolveReady();
      await joining;

      expect(manager.status()).toEqual([]);
      expect(connection.destroy).toHaveBeenCalledOnce();
    });

    it("does not restore realtime readiness after close wins connect", async () => {
      let resolveConnect!: () => void;
      realtimeSessionMock.connect.mockImplementationOnce(
        async () =>
          await new Promise<undefined>((resolve) => {
            resolveConnect = () => resolve(undefined);
          }),
      );
      const player = createAudioPlayerMock();
      const session = new realtimeModule.DiscordRealtimeVoiceSession({
        cfg: {},
        discordConfig: { voice: { enabled: true, mode: "agent-proxy", realtime: {} } },
        entry: {
          guildId: "g1",
          channelId: "1001",
          voiceSessionKey: "discord:g1:1001",
          route: { agentId: "agent-1", sessionKey: "discord:g1:1001" },
          player,
        },
        mode: "agent-proxy",
        onTerminalError: vi.fn(),
        runAgentTurn: vi.fn(),
      } as never);

      const connect = session.connect();
      await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
      session.close();
      resolveConnect();
      await connect;

      expect((session as unknown as { lifecycle: { status: string } }).lifecycle.status).toBe(
        "stopped",
      );
    });

    it("provider reset fences transcript, tool, playback, and consult completions", async () => {
      const onUtterance = vi.fn();
      let resolveConsult!: (result: { payloads: Array<{ text: string }> }) => void;
      agentCommandMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveConsult = resolve;
        }),
      );
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture();
      await manager.join(
        { guildId: "g1", channelId: "1001" },
        { transcripts: { sessionId: "transcript-1", onUtterance } },
      );
      beginSpeakerTurn(entry);
      const consult = bridgeParams.onToolCall?.(
        {
          itemId: "item-stale-consult",
          callId: "call-stale-consult",
          name: "openclaw_agent_consult",
          args: { question: "check stale state" },
        },
        realtimeSessionMock,
      );
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
      beginSpeakerTurn(entry);
      bridgeParams.audioSink.sendAudio(Buffer.alloc(24_000));
      const playCallsBeforeReset = player.play.mock.calls.length;
      bridgeParams.onTranscript?.("user", "stale transcript", true);
      bridgeParams.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      resolveConsult({ payloads: [{ text: "stale consult completion" }] });
      await consult;
      bridgeParams.onResponseDone?.({ status: "completed" });
      await Promise.resolve();
      await Promise.resolve();

      expect(onUtterance).not.toHaveBeenCalled();
      expect(realtimeSessionMock.submitToolResult).not.toHaveBeenCalled();
      expect(player.play).toHaveBeenCalledTimes(playCallsBeforeReset);
      expectUserMessageNotIncludes("stale consult completion");
    });

    it("DiscordVoiceReadyListener: starts autoJoin fire-and-forget on ready", async () => {
      const manager = createManager();
      const autoJoinSpy = vi
        .spyOn(manager, "autoJoin")
        .mockRejectedValue(new Error("autoJoin rejected"));

      const { DiscordVoiceReadyListener } = managerModule;
      const listener = new DiscordVoiceReadyListener(manager);

      await expect(listener.handle(undefined, undefined as never)).resolves.toBeUndefined();
      expect(autoJoinSpy).toHaveBeenCalledTimes(1);
    });

    it("DiscordVoiceResumedListener: runs autoJoin on gateway resume", async () => {
      const manager = createManager();
      const autoJoinSpy = vi.spyOn(manager, "autoJoin").mockResolvedValue(undefined);

      const { DiscordVoiceResumedListener } = managerModule;
      const listener = new DiscordVoiceResumedListener(manager);

      await expect(listener.handle(undefined, undefined as never)).resolves.toBeUndefined();
      expect(autoJoinSpy).toHaveBeenCalledTimes(1);
    });
  },
);
