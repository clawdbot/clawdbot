import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createDefaultVoiceStates,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    agentCommandMock,
    resolveVoiceIngressWithParticipantsMock,
    transcribeAudioFileMock,
    prepareTtsRequestMock,
    textToSpeechStreamMock,
    textToSpeechMock,
    logVerboseMock,
    loggerWarnMock,
    controlRealtimeVoiceAgentRunMock,
    realtimeSessionMock,
    decodeOpusStreamChunksMock,
    managerModule,
    realtimeModule,
    configureVoiceStateGateway,
    createClient,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    createFollowManager,
    getSessionEntry,
    getLastAudioPlayer,
    beginSpeakerTurn,
    lastAgentCommandArgs,
    lastAgentCommandToolNames,
    lastRealtimeBridgeParams,
    createJoinedAgentProxyFixture,
    lastTtsArgs,
    expectUserMessageNotIncludes,
    receiveVoiceUtterance,
    updateVoiceState,
    handleSpeakingStart,
    receiveRecordedSpeech,
  }) => {
    it("composes join, audio ingress, agent dispatch, playback, and leave", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "composed voice reply" }] });
      const manager = createManager({
        groupPolicy: "open",
        allowFrom: ["discord:u-speaker"],
        voice: { enabled: true, mode: "stt-tts" },
      });

      expect((await manager.join({ guildId: "g1", channelId: "1001" })).ok).toBe(true);
      const entry = getSessionEntry(manager);
      await receiveRecordedSpeech(manager, undefined, entry, "u-speaker");
      await entry.playbackQueue;

      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        "u-speaker",
        expect.objectContaining({ end: { behavior: "Manual" } }),
      );
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(getLastAudioPlayer().play).toHaveBeenCalledOnce();
      expect((await manager.leave({ guildId: "g1" })).ok).toBe(true);
      expect(manager.status()).toEqual([]);
    });

    it.each([
      {
        name: "withholds owner-only tools from account allowlisted voice speakers",
        userId: "u-owner",
        client: () => createClientWithMember("u-owner", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
            client,
          ),
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
            makeVoiceConfig(
              {},
              { groupPolicy: "allowlist", allowFrom: [allowFrom], guilds: { g1: {} } },
            ),
            client,
          ),
        expectedOwner: false,
      })),
      {
        name: "keeps owner-only tools for commands.ownerAllowFrom voice speakers",
        userId: "100000000000000001",
        client: () => createClientWithMember("100000000000000001", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            makeVoiceConfig({}, { groupPolicy: "open", dmPolicy: "disabled" }),
            client,
            {
              commands: { ownerAllowFrom: ["discord:100000000000000001"] },
            },
          ),
        expectedOwner: true,
        toolNames: { include: ["gateway", "nodes", "openclaw"], exclude: [] },
      },
      {
        name: "admits the Discord command-owner wildcard without owner voice authority",
        userId: "u-owner",
        client: () => createClientWithMember("u-owner", "Owner", "1234"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            makeVoiceConfig({}, { groupPolicy: "open", dmPolicy: "disabled" }),
            client,
            {
              commands: { ownerAllowFrom: ["discord:*"] },
            },
          ),
        expectedOwner: false,
        toolNames: { include: ["exec"], exclude: ["gateway", "nodes", "openclaw"] },
      },
      {
        name: "does not use another provider's command owners for Discord voice",
        userId: "u-guest",
        client: () => createClientWithMember("u-guest", "Guest", "4321"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            makeVoiceConfig({}, { groupPolicy: "open", dmPolicy: "disabled" }),
            client,
            {
              commands: { ownerAllowFrom: ["telegram:u-guest"] },
            },
          ),
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
        name: "does not grant voice commands from open group policy alone",
        userId: "u-guest",
        client: () => createClientWithMember("u-guest", "Guest", "4321"),
        manager: (client: ReturnType<typeof createClient>) =>
          createManager(
            makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
            client,
          ),
        expectedOwner: null,
      },
    ])(
      "$name",
      async ({ client: createScenarioClient, manager: createScenarioManager, ...scenario }) => {
        const client = createScenarioClient();
        await receiveVoiceUtterance(createScenarioManager(client), scenario.userId);

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
      const manager = createManager(makeVoiceConfig({}, discordConfig), client);
      await receiveVoiceUtterance(manager, "u-owner");
      const entry = getSessionEntry(manager);
      await entry.playbackQueue;

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: entry.route?.sessionKey,
        text: "use the smaller implementation",
      });
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(lastTtsArgs().text).toBe("Got it. I steered the active run.");
      expect(getLastAudioPlayer().play).toHaveBeenCalledTimes(1);
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
      await receiveVoiceUtterance(manager, "u-guest");

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
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
        client,
        {},
      );
      try {
        await receiveVoiceUtterance(manager, "u-guest");
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
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-debug"] }),
        client,
        {},
      );

      await receiveVoiceUtterance(manager, "u-debug");

      const transcriptLog = logVerboseMock.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("transcript from Debug Speaker (u-debug)"));
      expect(transcriptLog).toContain("hello from voice ");
      expect(transcriptLog).not.toContain("\n");
      expect(transcriptLog?.length).toBeLessThan(650);
    });

    it("logs a failed streaming provider once per session when using file fallback", async () => {
      const replyText = "file fallback reply";
      agentCommandMock.mockResolvedValue({ payloads: [{ text: replyText }] } as never);
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
        client,
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);

      for (let index = 0; index < 2; index += 1) {
        await receiveRecordedSpeech(manager, undefined, entry, "u-guest");
      }
      await entry.playbackQueue;

      const fallbackWarnings = loggerWarnMock.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("using file fallback"));
      expect(fallbackWarnings).toEqual([
        "discord voice: streaming TTS failed provider=elevenlabs reasonCode=provider_error; using file fallback",
      ]);
      expect(fallbackWarnings[0]).not.toContain(replyText);
    });

    it("does not warn when an unsupported streaming provider uses file fallback", async () => {
      textToSpeechStreamMock.mockResolvedValueOnce({
        success: false,
        error: "TTS conversion failed: buffered does not support streaming TTS",
        attemptedProviders: ["buffered"],
        attempts: [
          {
            provider: "buffered",
            outcome: "skipped",
            reasonCode: "unsupported_for_streaming",
            error: "buffered does not support streaming TTS",
          },
        ],
      });
      agentCommandMock.mockResolvedValueOnce({
        payloads: [{ text: "buffered provider reply" }],
      } as never);
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-guest"] }),
        client,
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);

      await receiveRecordedSpeech(manager, undefined, entry, "u-guest");
      await entry.playbackQueue;

      expect(textToSpeechMock).toHaveBeenCalledOnce();
      expect(getLastAudioPlayer().play).toHaveBeenCalledOnce();
      expect(
        loggerWarnMock.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes("streaming TTS failed")),
      ).toEqual([]);
    });

    it("releases late TTS without playback after the voice session leaves", async () => {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "late voice reply" }] });
      const release = vi.fn(async () => undefined);
      let resolveStream!: (value: unknown) => void;
      textToSpeechStreamMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStream = resolve;
        }),
      );
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);

      const speaking = receiveRecordedSpeech(manager, undefined, entry, "u-speaker");
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

      expect(getLastAudioPlayer().play).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("passes per-channel system prompt context to voice agent runs", async () => {
      const client = createClientWithMember("u-guest", "Guest", "4321");
      const manager = createManager(
        {
          voice: { enabled: true, mode: "stt-tts" },
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
      await receiveVoiceUtterance(manager, "u-guest");

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
          voice: { enabled: true, mode: "stt-tts" },
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

      await receiveVoiceUtterance(manager, "u-owner");

      const commandArgs = lastAgentCommandArgs() as { extraSystemPrompt?: string } | undefined;
      expect(commandArgs?.extraSystemPrompt).toContain("Use short voice replies.");
      expect(commandArgs?.extraSystemPrompt).toContain('display_name="Peter"');
      expect(commandArgs?.extraSystemPrompt).toContain('display_name="Sam"');
      expect(commandArgs?.extraSystemPrompt).not.toContain("Molty");
      expect(commandArgs?.extraSystemPrompt).toContain(
        "Use this roster when asked who is currently present",
      );
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
          voice: { enabled: true, mode: "stt-tts" },
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

      await receiveVoiceUtterance(manager, "u-role");

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
      const member = {
        nickname: "Role Speaker",
        roles: ["role-voice"],
        user: { id: "u-role", username: "role", globalName: "Role", discriminator: "2222" },
      };
      client.fetchMember.mockResolvedValue(member);
      const manager = createManager(
        {
          voice: { enabled: true, mode: "stt-tts" },
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

      await receiveVoiceUtterance(manager, "u-role");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      client.fetchMember.mockResolvedValue({ ...member, roles: [] });
      await receiveVoiceUtterance(manager, "u-role");

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(client.fetchMember).toHaveBeenLastCalledWith("g1", "u-role");
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
          voice: { enabled: true, mode: "stt-tts" },
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

      await receiveVoiceUtterance(manager, "u-owner");

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
      let resolveDecode!: () => void;
      const decodeReady = new Promise<void>((resolve) => {
        resolveDecode = resolve;
      });
      decodeOpusStreamChunksMock.mockImplementationOnce(
        async (
          input: Readable,
          callbacks: { onChunk: (pcm: Buffer, packet: Buffer) => void | Promise<void> },
        ) => {
          for await (const packet of input) {
            await decodeReady;
            await callbacks.onChunk(Buffer.alloc(96_000), packet);
          }
        },
      );
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-speaker"] }),
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const stream = new PassThrough({ objectMode: true });
      connection.receiver.subscribe.mockReturnValueOnce(stream);

      const speaking = handleSpeakingStart(manager, entry, "u-speaker");
      stream.end(Buffer.from("opus-packet"));
      await vi.waitFor(() => expect(decodeOpusStreamChunksMock).toHaveBeenCalledOnce());
      await manager.leave({ guildId: "g1" });
      resolveDecode();
      await speaking;
      await entry.processingQueue;

      expect(transcribeAudioFileMock).not.toHaveBeenCalled();
      expect(getLastAudioPlayer().play).not.toHaveBeenCalled();
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
        accountId: "default",
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
      const provider = lastRealtimeBridgeParams();
      session.close();
      expect(provider.audioSink.isOpen?.()).toBe(false);
      resolveConnect();
      await connect;

      provider.onReady?.();
      expect(provider.audioSink.isOpen?.()).toBe(false);
      expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
    });

    it("provider reset fences tool, playback, and consult completions", async () => {
      let resolveConsult!: (result: { payloads: Array<{ text: string }> }) => void;
      agentCommandMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveConsult = resolve;
        }),
      );
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();
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
