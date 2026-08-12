import { PassThrough } from "node:stream";
import { DAVESession } from "@discordjs/voice";
import { expectDefined } from "@openclaw/normalization-core";
import { VoiceOpcodes, type VoiceSendPayload } from "discord-api-types/voice/v8";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { createVoiceCaptureState } from "./capture-state.js";
import {
  createDefaultVoiceStates,
  createDiscordVoiceTestHelpers,
  createVoiceTestRuntime,
  lastMockCall,
  mockCall,
  type MockCallSource,
  requireRecord,
  type TestRealtimeBridgeParams,
  type TestRealtimeSessionEntry,
} from "./manager.e2e.test-support.js";
import { createVoiceReceiveRecoveryState, DECRYPT_FAILURE_WINDOW_MS } from "./receive-recovery.js";
import { voiceTestMocks } from "./voice-test-mocks.test-support.js";

const {
  createConnectionMock,
  getVoiceConnectionMock,
  joinVoiceChannelMock,
  entersStateMock,
  createAudioPlayerMock,
  createAudioResourceMock,
  resolveAgentRouteMock,
  agentCommandMock,
  resolveRealtimeBootstrapContextInstructionsMock,
  resolveVoiceIngressWithParticipantsMock,
  transcribeAudioFileMock,
  prepareTtsRequestMock,
  textToSpeechStreamMock,
  textToSpeechMock,
  logVerboseMock,
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  controlRealtimeVoiceAgentRunMock,
  realtimeSessionMock,
  decodeOpusStreamMock,
  decodeOpusStreamChunksMock,
  updateVoiceStateMock,
  enqueueSystemEventMock,
} = voiceTestMocks;
const [managerModule, realtimeModule, segmentModule] = await Promise.all([
  import("./voice-runtime.js"),
  import("./realtime-session.runtime.js"),
  import("./segment.js"),
]);

const { configureVoiceStateGateway, createClient, createClientWithMember } =
  createDiscordVoiceTestHelpers(updateVoiceStateMock);
const createRuntime = createVoiceTestRuntime;

function buildVoiceTestHarness() {
  beforeEach(() => {
    getVoiceConnectionMock.mockReset();
    getVoiceConnectionMock.mockReturnValue(undefined);
    joinVoiceChannelMock.mockReset();
    joinVoiceChannelMock.mockImplementation(() => createConnectionMock());
    entersStateMock.mockReset();
    entersStateMock.mockResolvedValue(undefined);
    createAudioPlayerMock.mockClear();
    resolveAgentRouteMock.mockReset();
    resolveAgentRouteMock.mockReturnValue({ agentId: "agent-1", sessionKey: "discord:g1:c1" });
    agentCommandMock.mockReset();
    agentCommandMock.mockResolvedValue({ payloads: [] });
    resolveRealtimeBootstrapContextInstructionsMock.mockReset();
    resolveRealtimeBootstrapContextInstructionsMock.mockResolvedValue(undefined);
    resolveVoiceIngressWithParticipantsMock.mockReset();
    transcribeAudioFileMock.mockReset();
    transcribeAudioFileMock.mockResolvedValue({ text: "hello from voice" });
    prepareTtsRequestMock.mockReset();
    prepareTtsRequestMock.mockImplementation(
      async ({ cfg, text }: { cfg: unknown; text: string }) => ({
        cfg,
        directives: {
          cleanedText: text,
          hasDirective: false,
          overrides: {},
          warnings: [],
        },
      }),
    );
    textToSpeechStreamMock.mockReset();
    textToSpeechStreamMock.mockResolvedValue({ success: false, error: "stream unavailable" });
    textToSpeechMock.mockReset();
    textToSpeechMock.mockResolvedValue({ success: true, audioPath: "/tmp/voice.mp3" });
    logVerboseMock.mockClear();
    updateVoiceStateMock.mockClear();
    enqueueSystemEventMock.mockClear();
    enqueueSystemEventMock.mockReturnValue(true);
    createAudioResourceMock.mockClear();
    realtimeSessionMock.close.mockClear();
    realtimeSessionMock.connect.mockClear();
    realtimeSessionMock.sendAudio.mockClear();
    realtimeSessionMock.sendUserMessage.mockClear();
    realtimeSessionMock.handleBargeIn.mockClear();
    realtimeSessionMock.setMediaTimestamp.mockClear();
    realtimeSessionMock.submitToolResult.mockClear();
    realtimeSessionMock.bridge.supportsToolResultSuppression = true;
    createRealtimeVoiceBridgeSessionMock.mockClear();
    createRealtimeVoiceBridgeSessionMock.mockReturnValue(realtimeSessionMock);
    controlRealtimeVoiceAgentRunMock.mockReset();
    controlRealtimeVoiceAgentRunMock.mockResolvedValue({
      ok: false,
      mode: "steer",
      sessionKey: "discord:g1:c1",
      active: false,
      queued: false,
      reason: "no_active_run",
      message: "There is no active OpenClaw run to steer.",
      speak: true,
      show: true,
      suppress: false,
    });
    resolveConfiguredRealtimeVoiceProviderMock.mockClear();
    resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
      provider: { id: "openai", capabilities: { supportsActivationNameGating: true } },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    });
    decodeOpusStreamMock.mockReset();
    decodeOpusStreamChunksMock.mockReset();
    decodeOpusStreamChunksMock.mockResolvedValue(undefined);
  });

  const createManager = (
    discordConfig: ConstructorParameters<
      typeof managerModule.DiscordVoiceManager
    >[0]["discordConfig"] = { voice: { enabled: true, mode: "stt-tts" } },
    clientOverride?: ReturnType<typeof createClient>,
    cfgOverride: ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0]["cfg"] = {},
    accountId = "default",
    botUserId?: string,
  ) =>
    new managerModule.DiscordVoiceManager({
      client: (clientOverride ?? createClient()) as never,
      cfg: cfgOverride,
      discordConfig,
      accountId,
      runtime: createRuntime(),
      botUserId,
    });

  type DiscordConfig = ConstructorParameters<
    typeof managerModule.DiscordVoiceManager
  >[0]["discordConfig"];
  type VoiceConfig = NonNullable<DiscordConfig["voice"]>;
  type AgentProxyConfigOverrides = Omit<Partial<DiscordConfig>, "voice"> & {
    voice?: Partial<VoiceConfig>;
  };

  const makeVoiceConfig = (
    voice: Partial<VoiceConfig> = {},
    overrides: Omit<Partial<DiscordConfig>, "voice"> = {},
  ): DiscordConfig => ({
    ...overrides,
    voice: { enabled: true, mode: "stt-tts", ...voice },
  });

  const makeAgentProxyConfig = (overrides: AgentProxyConfigOverrides = {}): DiscordConfig => {
    const { voice, ...discord } = overrides;
    return makeVoiceConfig(
      {
        mode: "agent-proxy",
        ...voice,
        realtime: { provider: "openai", ...voice?.realtime },
      },
      { groupPolicy: "open", ...discord },
    );
  };

  const makeBidiConfig = (overrides: AgentProxyConfigOverrides = {}): DiscordConfig => {
    const { voice, ...discord } = overrides;
    return makeVoiceConfig(
      {
        mode: "bidi",
        ...voice,
        realtime: { provider: "openai", ...voice?.realtime },
      },
      { groupPolicy: "open", ...discord },
    );
  };

  const createAgentProxyManager = (
    clientOverride?: ReturnType<typeof createClient>,
    overrides?: AgentProxyConfigOverrides,
    cfgOverride?: ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0]["cfg"],
    botUserId?: string,
  ) =>
    createManager(
      makeAgentProxyConfig(overrides),
      clientOverride,
      cfgOverride,
      "default",
      botUserId,
    );

  const createFollowManager = (
    voice: Partial<VoiceConfig> = {},
    clientOverride?: ReturnType<typeof createClient>,
    overrides: Omit<Partial<DiscordConfig>, "voice"> = {},
    botUserId?: string,
  ) =>
    createManager(
      makeVoiceConfig({ followUsers: ["u-owner"], ...voice }, overrides),
      clientOverride,
      {},
      "default",
      botUserId,
    );

  const expectConnectedStatus = (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    channelId: string,
  ) => {
    expect(manager.status()).toEqual([
      {
        ok: true,
        message: `connected: guild g1 channel ${channelId}`,
        guildId: "g1",
        channelId,
      },
    ]);
  };

  const getSessionEntry = (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    guildId = "g1",
  ): TestRealtimeSessionEntry => {
    const entry = (
      manager as unknown as { sessions: Map<string, TestRealtimeSessionEntry> }
    ).sessions.get(guildId);
    if (!entry) {
      throw new Error(`expected Discord voice session for guild ${guildId}`);
    }
    if (!Object.hasOwn(entry, "realtime")) {
      const realtimeLifecycle = () =>
        (
          entry as unknown as {
            realtimeLifecycle:
              | { status: "inactive" | "stopped" }
              | { status: "starting" | "active"; instance: unknown };
          }
        ).realtimeLifecycle;
      Object.defineProperties(entry, {
        pendingRealtime: {
          configurable: true,
          get: () => {
            const lifecycle = realtimeLifecycle();
            return lifecycle.status === "starting" ? lifecycle.instance : undefined;
          },
        },
        realtime: {
          configurable: true,
          get: () => {
            const lifecycle = realtimeLifecycle();
            return lifecycle.status === "active" ? lifecycle.instance : undefined;
          },
        },
      });
    }
    return entry;
  };

  const getVoiceReceive = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) =>
    (
      manager as unknown as {
        receive: {
          daveRecoveryAttempts: Map<string, number>;
          handleReceiveError: (entry: unknown, error: unknown) => void;
          handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
          processSegment: (params: {
            entry: unknown;
            wavPath: string;
            userId: string;
            durationSeconds: number;
          }) => Promise<void>;
          scheduleCaptureFinalize: (entry: unknown, userId: string, reason: string) => void;
        };
      }
    ).receive;

  const getVoiceFollowing = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) =>
    (
      manager as unknown as {
        following: { followedUserChannels: Map<string, { channelId: string }> };
      }
    ).following;

  const beginSpeakerTurn = (
    entry: TestRealtimeSessionEntry,
    params: {
      extraSystemPrompt?: string;
      senderIsOwner?: boolean;
      speakerLabel?: string;
      userId?: string;
    } = {},
  ) => {
    const senderIsOwner = params.senderIsOwner ?? true;
    const turn = entry.realtime?.beginSpeakerTurn(
      {
        extraSystemPrompt: params.extraSystemPrompt,
        senderIsOwner,
        speakerLabel: params.speakerLabel ?? (senderIsOwner ? "Owner" : "Guest"),
      },
      params.userId ?? (senderIsOwner ? "u-owner" : "u-guest"),
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    return turn;
  };

  const createWakeNameFixture = async (agentName = "Molty") => {
    const manager = createAgentProxyManager(
      undefined,
      { voice: { realtime: { consultPolicy: "auto", requireWakeName: true } } },
      { agents: { list: [{ id: "agent-1", identity: { name: agentName } }] } },
    );
    await manager.join({ guildId: "g1", channelId: "1001" });
    return {
      bridgeParams: lastRealtimeBridgeParams(),
      entry: getSessionEntry(manager),
      manager,
    };
  };

  const getLastAudioPlayer = () => {
    const player = createAudioPlayerMock.mock.results.at(-1)?.value as
      | {
          on: ReturnType<typeof vi.fn>;
          play: ReturnType<typeof vi.fn>;
          state: { status: string };
          stop: ReturnType<typeof vi.fn>;
        }
      | undefined;
    if (!player) {
      throw new Error("expected Discord voice audio player to be created");
    }
    return player;
  };

  const expectOffEventWithFunction = (source: MockCallSource, event: string) => {
    const call = Array.from(source.mock.calls).find((candidate) => candidate[0] === event);
    if (!call) {
      throw new Error(`Expected ${event} listener removal`);
    }
    expect(call[1], `${event} listener`).toBeTypeOf("function");
  };

  const lastAgentCommandArgs = () =>
    requireRecord(
      lastMockCall(agentCommandMock as unknown as MockCallSource, "agent command")[0],
      "agent command args",
    );

  const lastAgentCommandToolNames = () => {
    const args = lastAgentCommandArgs();
    if (typeof args.senderIsOwner !== "boolean") {
      throw new Error("expected agent command owner identity");
    }
    return createOpenClawCodingTools({
      config: {},
      senderIsOwner: args.senderIsOwner,
      messageProvider: "discord",
      workspaceDir: "/tmp/openclaw-discord-voice-tools",
      agentDir: "/tmp/openclaw-discord-voice-agent",
    }).map((tool) => tool.name);
  };

  const agentCommandArgsAt = (index: number) =>
    requireRecord(
      mockCall(agentCommandMock as unknown as MockCallSource, index, `agent command ${index}`)[0],
      `agent command args ${index}`,
    );

  const lastRealtimeBridgeParams = (): TestRealtimeBridgeParams =>
    requireRecord(
      lastMockCall(
        createRealtimeVoiceBridgeSessionMock as unknown as MockCallSource,
        "realtime bridge",
      )[0],
      "realtime bridge params",
    ) as TestRealtimeBridgeParams;

  const joinManagerFixture = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
  ) => {
    await manager.join({ guildId: "g1", channelId: "1001" });
    return {
      bridgeParams: lastRealtimeBridgeParams(),
      entry: getSessionEntry(manager),
      manager,
      player: getLastAudioPlayer(),
    };
  };

  const createJoinedAgentProxyFixture = async (
    overrides: {
      client?: ReturnType<typeof createClient>;
      config?: AgentProxyConfigOverrides;
      cfg?: ConstructorParameters<typeof managerModule.DiscordVoiceManager>[0]["cfg"];
    } = {},
  ) =>
    joinManagerFixture(createAgentProxyManager(overrides.client, overrides.config, overrides.cfg));

  const createJoinedBidiFixture = async (config: AgentProxyConfigOverrides = {}) =>
    joinManagerFixture(createManager(makeBidiConfig(config)));

  const lastAudioResourceInput = () =>
    lastMockCall(createAudioResourceMock as unknown as MockCallSource, "audio resource")[0];

  const lastTtsArgs = () =>
    requireRecord(
      lastMockCall(textToSpeechMock as unknown as MockCallSource, "tts call")[0],
      "tts args",
    );

  const lastTtsStreamArgs = () =>
    requireRecord(
      lastMockCall(textToSpeechStreamMock as unknown as MockCallSource, "tts stream call")[0],
      "tts stream args",
    );

  const sentUserMessages = () =>
    Array.from(realtimeSessionMock.sendUserMessage.mock.calls).map(([message]) => String(message));

  const emitFinalRealtimeUserTranscript = async (
    bridgeParams:
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | null
      | undefined,
    text: string,
  ) => {
    await flushRealtimeForcedConsultTimers(() => {
      bridgeParams?.onTranscript?.("user", text, true);
    });
  };

  const flushRealtimeForcedConsultTimers = async (emitTranscripts: () => void | Promise<void>) => {
    vi.useFakeTimers();
    try {
      await emitTranscripts();
      await vi.advanceTimersByTimeAsync(260);
    } finally {
      vi.useRealTimers();
    }
  };

  const expectUserMessageIncludes = (text: string) => {
    expect(
      sentUserMessages().some((message) => message.includes(text)),
      text,
    ).toBe(true);
  };

  const expectUserMessageNotIncludes = (text: string) => {
    expect(
      sentUserMessages().some((message) => message.includes(text)),
      text,
    ).toBe(false);
  };

  const emitDecryptFailure = (manager: InstanceType<typeof managerModule.DiscordVoiceManager>) => {
    const entry = getSessionEntry(manager);
    getVoiceReceive(manager).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
  };

  const installFailingDaveSession = (
    connection: ReturnType<typeof createConnectionMock>,
    failure: "invalidation" | "native" | "key-package",
    beforeFailure?: () => void,
  ) => {
    const dave = new DAVESession(1, "bot", "1001", { decryptionFailureTolerance: 0 });
    const nativeSession = {
      decrypt: vi.fn(() => {
        throw new Error("UnencryptedWhenPassthroughDisabled");
      }),
      getSerializedKeyPackage: vi.fn(() => Buffer.from("new-key-package")),
      ready: true,
      reinit: vi.fn(() => {
        if (failure === "native") {
          beforeFailure?.();
          throw new Error("native DAVE reinitialization failed");
        }
      }),
      setPassthroughMode: connection.daveSetPassthroughMode,
    };
    dave.session = nativeSession as unknown as NonNullable<typeof dave.session>;
    dave.lastTransitionId = 0;
    const gateway = {
      sendPacket: vi.fn((_packet: VoiceSendPayload) => {
        if (failure === "invalidation") {
          beforeFailure?.();
          throw new Error("voice gateway invalidation failed");
        }
      }),
      sendBinaryMessage: vi.fn((_opcode: VoiceOpcodes, _keyPackage: Buffer) => {
        if (failure === "key-package") {
          beforeFailure?.();
          throw new Error("voice gateway key-package delivery failed");
        }
      }),
    };
    dave.on("invalidateTransition", (transitionId) => {
      gateway.sendPacket({
        op: VoiceOpcodes.DaveMlsInvalidCommitWelcome,
        d: { transition_id: transitionId },
      });
    });
    dave.on("keyPackage", (keyPackage) => {
      gateway.sendBinaryMessage(VoiceOpcodes.DaveMlsKeyPackage, keyPackage);
    });
    connection.state.networking.state.dave =
      dave as unknown as typeof connection.state.networking.state.dave;
    return { dave, gateway };
  };

  const makePoisonedDaveConnections = (additionalConnections = 0) => {
    const firstConnection = createConnectionMock();
    const secondConnection = createConnectionMock();
    installFailingDaveSession(firstConnection, "native");
    installFailingDaveSession(secondConnection, "key-package");
    const connections = [
      firstConnection,
      secondConnection,
      ...Array.from({ length: additionalConnections }, createConnectionMock),
    ];
    connections.forEach((connection) => joinVoiceChannelMock.mockReturnValueOnce(connection));
    return { firstConnection, secondConnection };
  };

  const processVoiceSegment = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    userId: string,
  ) =>
    await getVoiceReceive(manager).processSegment({
      entry: {
        guildId: "g1",
        channelId: "1001",
        sessionChannelId: "1001",
        voiceSessionKey: "discord:g1:1001",
        route: { sessionKey: "discord:g1:1001", agentId: "agent-1" },
        connection: createConnectionMock(),
        player: createAudioPlayerMock(),
        playbackQueue: Promise.resolve(),
        processingQueue: Promise.resolve(),
        capture: createVoiceCaptureState(),
        receiveRecovery: createVoiceReceiveRecoveryState(),
      },
      wavPath: "/tmp/test.wav",
      userId,
      durationSeconds: 1.2,
    });

  const updateVoiceState = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    userId: string,
    channelId: string | null,
    member?: Record<string, unknown>,
  ) => {
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: userId,
      channel_id: channelId,
      ...(member ? { member } : {}),
    } as never);
  };

  const handleSpeakingStart = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    entry: unknown,
    userId: string,
  ) => await getVoiceReceive(manager).handleSpeakingStart(entry, userId);

  return {
    PassThrough,
    DAVESession,
    expectDefined,
    VoiceOpcodes,
    createOpenClawCodingTools,
    expect,
    it,
    vi,
    ChannelType,
    createVoiceCaptureState,
    createVoiceReceiveRecoveryState,
    DECRYPT_FAILURE_WINDOW_MS,
    requireRecord,
    mockCall,
    lastMockCall,
    createDefaultVoiceStates,
    createConnectionMock,
    getVoiceConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    createAudioResourceMock,
    resolveAgentRouteMock,
    agentCommandMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    resolveVoiceIngressWithParticipantsMock,
    transcribeAudioFileMock,
    prepareTtsRequestMock,
    textToSpeechStreamMock,
    textToSpeechMock,
    logVerboseMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    createRealtimeVoiceBridgeSessionMock,
    controlRealtimeVoiceAgentRunMock,
    realtimeSessionMock,
    decodeOpusStreamMock,
    decodeOpusStreamChunksMock,
    updateVoiceStateMock,
    enqueueSystemEventMock,
    managerModule,
    realtimeModule,
    segmentModule,
    configureVoiceStateGateway,
    createClient,
    createClientWithMember,
    createRuntime,
    createManager,
    makeVoiceConfig,
    makeAgentProxyConfig,
    makeBidiConfig,
    createAgentProxyManager,
    createFollowManager,
    expectConnectedStatus,
    getSessionEntry,
    getVoiceReceive,
    getVoiceFollowing,
    beginSpeakerTurn,
    createWakeNameFixture,
    getLastAudioPlayer,
    expectOffEventWithFunction,
    lastAgentCommandArgs,
    lastAgentCommandToolNames,
    agentCommandArgsAt,
    lastRealtimeBridgeParams,
    joinManagerFixture,
    createJoinedAgentProxyFixture,
    createJoinedBidiFixture,
    lastAudioResourceInput,
    lastTtsArgs,
    lastTtsStreamArgs,
    sentUserMessages,
    emitFinalRealtimeUserTranscript,
    flushRealtimeForcedConsultTimers,
    expectUserMessageIncludes,
    expectUserMessageNotIncludes,
    emitDecryptFailure,
    installFailingDaveSession,
    makePoisonedDaveConnections,
    processVoiceSegment,
    updateVoiceState,
    handleSpeakingStart,
  };
}

type DiscordVoiceTestHarness = ReturnType<typeof buildVoiceTestHarness>;

export function defineDiscordVoiceTests(
  register: (harness: DiscordVoiceTestHarness) => void,
): void {
  describe("DiscordVoiceManager", () => {
    register(buildVoiceTestHarness());
  });
}
