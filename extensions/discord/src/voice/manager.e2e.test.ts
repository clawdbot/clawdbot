import { PassThrough, type Readable } from "node:stream";
import type { RealtimeVoiceAgentControlResult } from "openclaw/plugin-sdk/realtime-voice";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { createVoiceCaptureState } from "./capture-state.js";
import { createVoiceReceiveRecoveryState } from "./receive-recovery.js";

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
  transcribeAudioFileMock,
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
} = vi.hoisted(() => {
  type EventHandler = (...args: unknown[]) => unknown;
  type MockConnection = {
    destroy: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    receiver: {
      speaking: {
        on: ReturnType<typeof vi.fn>;
        off: ReturnType<typeof vi.fn>;
      };
      subscribe: ReturnType<typeof vi.fn>;
    };
    state: {
      status: string;
      networking: {
        state: {
          code: string;
          dave: {
            session: {
              setPassthroughMode: ReturnType<typeof vi.fn>;
            };
          };
        };
      };
    };
    daveSetPassthroughMode: ReturnType<typeof vi.fn>;
    handlers: Map<string, EventHandler>;
  };

  const createConnectionMock = (): MockConnection => {
    const handlers = new Map<string, EventHandler>();
    const daveSetPassthroughMode = vi.fn();
    const connection: MockConnection = {
      destroy: vi.fn(),
      subscribe: vi.fn(),
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
      receiver: {
        speaking: {
          on: vi.fn(),
          off: vi.fn(),
        },
        subscribe: vi.fn(() => ({
          on: vi.fn(),
          off: vi.fn(),
          destroy: vi.fn(),
          async *[Symbol.asyncIterator]() {},
        })),
      },
      state: {
        status: "ready",
        networking: {
          state: {
            code: "networking-ready",
            dave: {
              session: {
                setPassthroughMode: daveSetPassthroughMode,
              },
            },
          },
        },
      },
      daveSetPassthroughMode,
      handlers,
    };
    return connection;
  };

  const getVoiceConnectionMock = vi.fn((): MockConnection | undefined => undefined);

  const realtimeSessionMock = {
    bridge: { supportsToolResultContinuation: true },
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    sendUserMessage: vi.fn(),
    handleBargeIn: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    triggerGreeting: vi.fn(),
  };

  return {
    createConnectionMock,
    getVoiceConnectionMock,
    joinVoiceChannelMock: vi.fn(() => createConnectionMock()),
    entersStateMock: vi.fn(async (_target?: unknown, _state?: string, _timeoutMs?: number) => {
      return undefined;
    }),
    createAudioResourceMock: vi.fn(),
    createAudioPlayerMock: vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(),
      play: vi.fn(),
      state: { status: "idle" },
    })),
    resolveAgentRouteMock: vi.fn(() => ({ agentId: "agent-1", sessionKey: "discord:g1:c1" })),
    agentCommandMock: vi.fn(
      async (
        _opts?: unknown,
        _runtime?: unknown,
      ): Promise<{ payloads?: Array<{ text?: string }> }> => ({ payloads: [] }),
    ),
    resolveRealtimeBootstrapContextInstructionsMock: vi.fn<
      (...args: unknown[]) => Promise<string | undefined>
    >(async () => undefined),
    transcribeAudioFileMock: vi.fn(async () => ({ text: "hello from voice" })),
    textToSpeechStreamMock: vi.fn(
      async (): Promise<unknown> => ({ success: false, error: "stream unavailable" }),
    ),
    textToSpeechMock: vi.fn(async () => ({ success: true, audioPath: "/tmp/voice.mp3" })),
    logVerboseMock: vi.fn(),
    resolveConfiguredRealtimeVoiceProviderMock: vi.fn(() => ({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    })),
    createRealtimeVoiceBridgeSessionMock: vi.fn((_params?: unknown) => realtimeSessionMock),
    controlRealtimeVoiceAgentRunMock: vi.fn<() => Promise<RealtimeVoiceAgentControlResult>>(
      async () => ({
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
      }),
    ),
    realtimeSessionMock,
    decodeOpusStreamMock: vi.fn(),
    decodeOpusStreamChunksMock: vi.fn(),
    updateVoiceStateMock: vi.fn(),
  };
});

vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    EndBehaviorType: { AfterSilence: "AfterSilence", Manual: "Manual" },
    NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
    StreamType: { Opus: "opus", Raw: "raw" },
    VoiceConnectionStatus: {
      Ready: "ready",
      Disconnected: "disconnected",
      Destroyed: "destroyed",
      Signalling: "signalling",
      Connecting: "connecting",
    },
    createAudioPlayer: createAudioPlayerMock,
    createAudioResource: createAudioResourceMock,
    entersState: entersStateMock,
    getVoiceConnection: getVoiceConnectionMock,
    joinVoiceChannel: joinVoiceChannelMock,
  }),
}));

vi.mock("openclaw/plugin-sdk/routing", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/routing")>(
    "openclaw/plugin-sdk/routing",
  );
  return {
    ...actual,
    resolveAgentRoute: resolveAgentRouteMock,
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  return {
    ...actual,
    agentCommandFromIngress: agentCommandMock,
    getTtsProvider: vi.fn(() => "openai"),
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
    resolveTtsConfig: vi.fn(() => ({
      modelOverrides: {},
      providerConfigs: {},
    })),
    resolveTtsPrefsPath: vi.fn(() => "/tmp/openclaw-tts.json"),
  };
});

vi.mock("openclaw/plugin-sdk/realtime-bootstrap-context", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/realtime-bootstrap-context")
  >("openclaw/plugin-sdk/realtime-bootstrap-context");
  return {
    ...actual,
    resolveRealtimeBootstrapContextInstructions: resolveRealtimeBootstrapContextInstructionsMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/realtime-voice", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/realtime-voice")>(
    "openclaw/plugin-sdk/realtime-voice",
  );
  return {
    ...actual,
    createRealtimeVoiceBridgeSession: createRealtimeVoiceBridgeSessionMock,
    controlRealtimeVoiceAgentRun: controlRealtimeVoiceAgentRunMock,
    resolveConfiguredRealtimeVoiceProvider: resolveConfiguredRealtimeVoiceProviderMock,
  };
});

vi.mock("./audio.js", async () => {
  const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    createDiscordOpusEncodeStream: vi.fn(() => new PassThrough()),
    createDiscordOpusPlaybackStream: vi.fn(() => new PassThrough()),
    decodeOpusStream: (...args: Parameters<typeof actual.decodeOpusStream>) =>
      decodeOpusStreamMock.getMockImplementation()
        ? decodeOpusStreamMock(...args)
        : actual.decodeOpusStream(...args),
    decodeOpusStreamChunks: decodeOpusStreamChunksMock,
  };
});

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    mediaUnderstanding: {
      transcribeAudioFile: transcribeAudioFileMock,
    },
    tts: {
      textToSpeechStream: textToSpeechStreamMock,
      textToSpeech: textToSpeechMock,
    },
  }),
}));

let managerModule: typeof import("./manager.js");
let segmentModule: typeof import("./segment.js");

function createVoiceChannelInfo(
  channelId: string,
  guildId = "g1",
  guildName = "Guild One",
): {
  id: string;
  guildId: string;
  guild: { id: string; name: string };
  type: ChannelType;
} {
  return {
    id: channelId,
    guildId,
    guild: { id: guildId, name: guildName },
    type: ChannelType.GuildVoice,
  };
}

type VoiceChannelInfo = ReturnType<typeof createVoiceChannelInfo>;

function createClient() {
  return {
    rest: {
      get: vi.fn(),
    },
    fetchChannel: vi.fn(
      async (channelId: string): Promise<VoiceChannelInfo | null> =>
        createVoiceChannelInfo(channelId),
    ),
    fetchGuild: vi.fn(async (guildId: string) => ({
      id: guildId,
      name: "Guild One",
    })),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
      getGateway: vi.fn(() => ({
        updateVoiceState: updateVoiceStateMock,
      })),
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("DiscordVoiceManager", () => {
  beforeAll(async () => {
    [managerModule, segmentModule] = await Promise.all([
      import("./manager.js"),
      import("./segment.js"),
    ]);
  });

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
    transcribeAudioFileMock.mockReset();
    transcribeAudioFileMock.mockResolvedValue({ text: "hello from voice" });
    textToSpeechStreamMock.mockReset();
    textToSpeechStreamMock.mockResolvedValue({ success: false, error: "stream unavailable" });
    textToSpeechMock.mockReset();
    textToSpeechMock.mockResolvedValue({ success: true, audioPath: "/tmp/voice.mp3" });
    logVerboseMock.mockClear();
    updateVoiceStateMock.mockClear();
    createAudioResourceMock.mockClear();
    realtimeSessionMock.close.mockClear();
    realtimeSessionMock.connect.mockClear();
    realtimeSessionMock.sendAudio.mockClear();
    realtimeSessionMock.sendUserMessage.mockClear();
    realtimeSessionMock.handleBargeIn.mockClear();
    realtimeSessionMock.setMediaTimestamp.mockClear();
    realtimeSessionMock.submitToolResult.mockClear();
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
      provider: { id: "openai" },
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
  ) =>
    new managerModule.DiscordVoiceManager({
      client: (clientOverride ?? createClient()) as never,
      cfg: cfgOverride,
      discordConfig,
      accountId: "default",
      runtime: createRuntime(),
    });

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
  ) => {
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(guildId);
    if (!entry) {
      throw new Error(`expected Discord voice session for guild ${guildId}`);
    }
    return entry;
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

  type MockCallSource = {
    mock: {
      calls: ArrayLike<ReadonlyArray<unknown>>;
    };
  };

  const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object") {
      throw new Error(`expected ${label}`);
    }
    return value as Record<string, unknown>;
  };

  const mockCall = (source: MockCallSource, index: number, label: string) => {
    const call = source.mock.calls[index];
    if (!call) {
      throw new Error(`expected mock call: ${label}`);
    }
    return call;
  };

  const lastMockCall = (source: MockCallSource, label: string) => {
    const calls = Array.from(source.mock.calls);
    const call = calls[calls.length - 1];
    if (!call) {
      throw new Error(`expected mock call: ${label}`);
    }
    return call;
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

  const agentCommandArgsAt = (index: number) =>
    requireRecord(
      mockCall(agentCommandMock as unknown as MockCallSource, index, `agent command ${index}`)[0],
      `agent command args ${index}`,
    );

  const lastRealtimeBridgeParams = () =>
    requireRecord(
      lastMockCall(
        createRealtimeVoiceBridgeSessionMock as unknown as MockCallSource,
        "realtime bridge",
      )[0],
      "realtime bridge params",
    );

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
    (
      manager as unknown as { handleReceiveError: (e: unknown, err: unknown) => void }
    ).handleReceiveError(
      entry,
      new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
    );
  };

  it("rejects joins when Discord voice config is absent", async () => {
    const manager = createManager({});

    const result = await manager.join({ guildId: "g1", channelId: "1001" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Discord voice is disabled (channels.discord.voice.enabled).");

    expect(joinVoiceChannelMock).not.toHaveBeenCalled();
  });

  type ProcessSegmentInvoker = {
    processSegment: (params: {
      entry: unknown;
      wavPath: string;
      userId: string;
      durationSeconds: number;
    }) => Promise<void>;
  };

  const processVoiceSegment = async (
    manager: InstanceType<typeof managerModule.DiscordVoiceManager>,
    userId: string,
  ) =>
    await (manager as unknown as ProcessSegmentInvoker).processSegment({
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
  });

  it("attaches transcripts capture to an existing voice session", async () => {
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    const onUtterance = vi.fn();
    const result = await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );

    const entry = getSessionEntry(manager) as {
      transcripts?: { sessionId: string; onUtterance: typeof onUtterance };
    };
    expect(result.ok).toBe(true);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
    expect(entry.transcripts).toEqual({
      sessionId: "notes-1",
      onUtterance,
    });
  });

  it("does not leave a newer transcripts-only session for a stale stop", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });
    const firstUtterance = vi.fn();
    const secondUtterance = vi.fn();

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance: firstUtterance,
        },
      },
    );
    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-2",
          onUtterance: secondUtterance,
        },
      },
    );

    const result = await manager.leave(
      { guildId: "g1", channelId: "1001" },
      { transcriptsSessionId: "notes-1" },
    );
    const entry = getSessionEntry(manager) as {
      transcripts?: { sessionId: string; onUtterance: typeof secondUtterance };
    };

    expect(result.ok).toBe(false);
    expect(entry.transcripts).toEqual({
      sessionId: "notes-2",
      onUtterance: secondUtterance,
    });
    expectConnectedStatus(manager, "1001");
  });

  it("upgrades a transcripts-only session to realtime on a normal join", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });
    const onUtterance = vi.fn();

    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
    expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();

    const entry = getSessionEntry(manager) as {
      transcripts?: { sessionId: string; onUtterance: typeof onUtterance };
      realtime?: unknown;
    };
    let resolveRealtimeReady!: () => void;
    const realtimeReady = new Promise<undefined>((resolve) => {
      resolveRealtimeReady = () => resolve(undefined);
    });
    realtimeSessionMock.connect.mockImplementationOnce(async () => realtimeReady);

    const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

    await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
    expect(entry.realtime).toBeUndefined();

    resolveRealtimeReady();
    const result = await upgrade;

    expect(result.ok).toBe(true);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
    expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1);
    expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
    expect(entry.transcripts).toEqual({
      sessionId: "notes-1",
      onUtterance,
    });
    expect(entry.realtime).toBeTruthy();

    const stopNotesResult = await manager.leave(
      { guildId: "g1", channelId: "1001" },
      { transcriptsSessionId: "notes-1" },
    );

    expect(stopNotesResult.ok).toBe(true);
    expect(entry.transcripts).toBeUndefined();
    expect(entry.realtime).toBeTruthy();
    expect(realtimeSessionMock.close).not.toHaveBeenCalled();
    expectConnectedStatus(manager, "1001");
  });

  it("closes a pending realtime upgrade if the voice entry stops before connect resolves", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });
    const onUtterance = vi.fn();

    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
    const entry = getSessionEntry(manager) as {
      pendingRealtime?: unknown;
      realtime?: unknown;
      stop: () => void;
    };
    let resolveRealtimeReady!: () => void;
    const realtimeReady = new Promise<undefined>((resolve) => {
      resolveRealtimeReady = () => resolve(undefined);
    });
    realtimeSessionMock.connect.mockImplementationOnce(async () => realtimeReady);

    const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

    await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
    expect(entry.pendingRealtime).toBeTruthy();
    expect(entry.realtime).toBeUndefined();

    entry.stop();
    expect(realtimeSessionMock.close).toHaveBeenCalled();
    expect(entry.pendingRealtime).toBeUndefined();
    expect(entry.realtime).toBeUndefined();

    resolveRealtimeReady();
    const result = await upgrade;

    expect(result.ok).toBe(false);
    expect(result.message).toContain("stopped before startup completed");
    expect(entry.realtime).toBeUndefined();
  });

  it("detaches transcripts without leaving voice during pending realtime upgrade", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });
    const onUtterance = vi.fn();

    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
    const entry = getSessionEntry(manager) as {
      transcripts?: { sessionId: string; onUtterance: typeof onUtterance };
      pendingRealtime?: unknown;
      realtime?: unknown;
    };
    let resolveRealtimeReady!: () => void;
    const realtimeReady = new Promise<undefined>((resolve) => {
      resolveRealtimeReady = () => resolve(undefined);
    });
    realtimeSessionMock.connect.mockImplementationOnce(async () => realtimeReady);

    const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

    await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
    const stopNotesResult = await manager.leave(
      { guildId: "g1", channelId: "1001" },
      { transcriptsSessionId: "notes-1" },
    );

    expect(stopNotesResult.ok).toBe(true);
    expect(entry.transcripts).toBeUndefined();
    expect(entry.pendingRealtime).toBeTruthy();
    expect(entry.realtime).toBeUndefined();

    resolveRealtimeReady();
    const result = await upgrade;

    expect(result.ok).toBe(true);
    expect(entry.pendingRealtime).toBeUndefined();
    expect(entry.realtime).toBeTruthy();
    expectConnectedStatus(manager, "1001");
  });

  it("does not start realtime upgrade if the voice entry leaves during bootstrap", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });
    const onUtterance = vi.fn();

    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
    let resolveBootstrap!: () => void;
    const bootstrapReady = new Promise<undefined>((resolve) => {
      resolveBootstrap = () => resolve(undefined);
    });
    resolveRealtimeBootstrapContextInstructionsMock.mockImplementationOnce(
      async () => bootstrapReady,
    );

    const upgrade = manager.join({ guildId: "g1", channelId: "1001" });
    await Promise.resolve();

    const leaveResult = await manager.leave({ guildId: "g1" });
    resolveBootstrap();
    const result = await upgrade;

    expect(leaveResult.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("stopped before startup completed");
    expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
  });

  it("keeps realtime playback alive when transcripts attaches to an existing voice session", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai", consultPolicy: "auto" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const player = getLastAudioPlayer();
    const entry = getSessionEntry(manager) as {
      transcripts?: { sessionId: string; onUtterance: (event: unknown) => Promise<void> };
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
    const stopCallsBeforeTranscripts = player.stop.mock.calls.length;
    const onUtterance = vi.fn(async () => undefined);

    const result = await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(entry.transcripts?.sessionId).toBe("notes-1");
    expect(realtimeSessionMock.close).not.toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeTranscripts);

    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(3840));
    bridgeParams?.onTranscript?.("user", "meeting note transcript", true);

    await vi.waitFor(() =>
      expect(onUtterance).toHaveBeenCalledWith(
        expect.objectContaining({
          final: true,
          sessionId: "notes-1",
          speaker: { id: "u-owner", label: "Owner" },
          text: "meeting note transcript",
          metadata: expect.objectContaining({
            channel: "discord",
            channelId: "1001",
            guildId: "g1",
            voiceSessionKey: "discord:g1:c1",
          }),
        }),
      ),
    );
    turn?.close();
  });

  it("destroys stale tracked voice connections before joining", async () => {
    const staleConnection = createConnectionMock();
    const connection = createConnectionMock();
    getVoiceConnectionMock.mockReturnValueOnce(staleConnection);
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(getVoiceConnectionMock).toHaveBeenCalledWith("g1");
    expect(staleConnection.destroy).toHaveBeenCalledTimes(1);
    expectConnectedStatus(manager, "1001");
  });

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

  it("suppresses repeated autoJoin attempts after fatal realtime startup failures", async () => {
    realtimeSessionMock.connect.mockRejectedValueOnce(new Error("Incorrect API key provided"));
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "agent-proxy",
        autoJoin: [{ guildId: "g1", channelId: "1001" }],
      },
    });

    await manager.autoJoin();
    await manager.autoJoin();

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
    expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
    expect(manager.status()).toStrictEqual([]);
  });

  it("rejects joins outside configured allowed voice channels", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        allowedChannels: [{ guildId: "g1", channelId: "1001" }],
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1002" });

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "<#1002> is not allowed by channels.discord.voice.allowedChannels.",
    );
    expect(joinVoiceChannelMock).not.toHaveBeenCalled();
  });

  it("allows joins inside configured allowed voice channels", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        allowedChannels: [{ guildId: "g1", channelId: "1001" }],
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(true);
    expectConnectedStatus(manager, "1001");
  });

  it("follows configured users into voice channels", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["discord:u-owner"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
    expectConnectedStatus(manager, "1001");
  });

  it("does not follow configured users when followUsersEnabled is false", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsersEnabled: false,
        followUsers: ["u-owner"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);

    expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    expect(manager.status()).toEqual([]);
  });

  it("disconnects stale bot voice state when followed users are absent during reconciliation", async () => {
    const client = createClient();
    client.rest.get.mockRejectedValueOnce(new Error("Unknown Voice State")).mockResolvedValueOnce({
      guild_id: "g1",
      user_id: "bot-user",
      channel_id: "1001",
    });
    const manager = createManager(
      {
        guilds: { g1: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: ["u-owner"],
        },
      },
      client,
    );
    manager.setBotUserId("bot-user");

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
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["u-owner"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1002",
    } as never);

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    expectConnectedStatus(manager, "1002");
  });

  it("preserves follow ownership when a bot voice move rebuilds the session", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["u-owner"],
      },
    });
    manager.setBotUserId("bot-user");

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "bot-user",
      channel_id: "1002",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: null,
    } as never);

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    expect(manager.status()).toEqual([]);
  });

  it("leaves when a followed user disconnects", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["u-owner"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: null,
    } as never);

    expect(manager.status()).toEqual([]);
  });

  it("hands off to another followed user when the active followed user disconnects", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        allowedChannels: [
          { guildId: "g1", channelId: "1001" },
          { guildId: "g1", channelId: "1002" },
        ],
        followUsers: ["u-owner", "u-backup"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-backup",
      channel_id: "1002",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: null,
    } as never);

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
    const manager = createManager(
      {
        voice: {
          enabled: true,
          mode: "stt-tts",
          allowedChannels: [
            { guildId: "g1", channelId: "1001" },
            { guildId: "g1", channelId: "1002" },
          ],
          followUsers: ["u-owner", "u-backup"],
        },
      },
      client,
    );

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-backup",
      channel_id: "1002",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: null,
    } as never);

    expect(manager.status()).toEqual([]);
  });

  it("does not follow configured users into disallowed channels", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["u-owner"],
        allowedChannels: [{ guildId: "g1", channelId: "1001" }],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1002",
    } as never);

    expect(joinVoiceChannelMock).not.toHaveBeenCalled();
    expect(manager.status()).toEqual([]);
  });

  it("bounds followed user reconciliation REST lookups", async () => {
    const client = createClient();
    client.rest.get.mockRejectedValue(new Error("Unknown Voice State"));
    const guilds = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`g${index + 1}`, {}]),
    );
    const manager = createManager(
      {
        guilds,
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: ["u1", "u2", "u3", "u4", "u5"],
        },
      },
      client,
    );
    manager.setBotUserId("bot-user");

    await manager.autoJoin();
    await manager.destroy();

    expect(client.rest.get).toHaveBeenCalledTimes(24);
  });

  it("keeps followed voice state when reconciliation hits a transient REST failure", async () => {
    const client = createClient();
    const manager = createManager(
      {
        guilds: { g1: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: ["u-owner"],
        },
      },
      client,
    );

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);
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
    const manager = createManager(
      {
        guilds: { g1: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: ["u-owner"],
        },
      },
      client,
    );

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
    const manager = createManager(
      {
        guilds: { g1: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: Array.from({ length: 40 }, (_, index) => `u${index + 1}`),
        },
      },
      client,
    );
    manager.setBotUserId("bot-user");

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
    const manager = createManager(
      {
        guilds: { g1: {}, g2: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: Array.from({ length: 40 }, (_, index) => `u${index + 1}`),
        },
      },
      client,
    );
    manager.setBotUserId("bot-user");

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
    const manager = createManager(
      {
        guilds: { g1: {}, g2: {}, g3: {} },
        voice: {
          enabled: true,
          mode: "stt-tts",
          followUsers: Array.from({ length: 10 }, (_, index) => `u${index + 1}`),
        },
      },
      client,
    );
    manager.setBotUserId("bot-user");

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
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        allowedChannels: [],
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(false);
    expect(joinVoiceChannelMock).not.toHaveBeenCalled();
  });

  it("leaves and rejoins the configured target when Discord moves the bot outside allowed voice channels", async () => {
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        autoJoin: [{ guildId: "g1", channelId: "1001" }],
        allowedChannels: [{ guildId: "g1", channelId: "1001" }],
      },
    });
    manager.setBotUserId("bot-user");
    await manager.join({ guildId: "g1", channelId: "1001" });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "bot-user",
      channel_id: "1002",
    } as never);

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

  it("ignores new capture while playback is running", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    const player = getLastAudioPlayer();
    const entry = getSessionEntry(manager);
    player.state.status = "playing";

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u1");

    expect(player.stop).not.toHaveBeenCalled();
    expect(connection.receiver.subscribe).not.toHaveBeenCalled();
  });

  it("allows configured realtime barge-in when provider input interruption is disabled", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          bargeIn: true,
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const player = getLastAudioPlayer();
    const entry = getSessionEntry(manager);
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;
    player.state.status = "playing";
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u1");

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
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          bargeIn: true,
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;
    const player = getLastAudioPlayer();
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u1",
    );

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    turn?.sendInputAudio(Buffer.alloc(3840));

    expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(0);
    expect(realtimeSessionMock.setMediaTimestamp).toHaveBeenCalledWith(10);
    expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalled();
    const lastTimestampCall = realtimeSessionMock.setMediaTimestamp.mock.invocationCallOrder.at(-1);
    const firstBargeInCall = realtimeSessionMock.handleBargeIn.mock.invocationCallOrder[0];
    expect(lastTimestampCall).toBeLessThan(firstBargeInCall);
    expect(player.stop).not.toHaveBeenCalled();
    expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
  });

  it("does not interrupt realtime provider state when local playback is already idle", async () => {
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          bargeIn: true,
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const player = getLastAudioPlayer();
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u1",
    );

    turn?.sendInputAudio(Buffer.alloc(3840));

    expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(player.stop).not.toHaveBeenCalled();
    expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
  });

  it("sends trailing realtime silence when a speaker turn closes", async () => {
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              silenceDurationMs: 450,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u1",
    );

    turn?.sendInputAudio(Buffer.alloc(3840));
    turn?.close();

    expect(realtimeSessionMock.sendAudio).toHaveBeenCalledTimes(2);
    const trailingSilence = realtimeSessionMock.sendAudio.mock.calls.at(-1)?.[0] as
      | Buffer
      | undefined;
    expect(trailingSilence).toBeInstanceOf(Buffer);
    expect(trailingSilence?.length).toBe(33_600);
    expect(trailingSilence?.equals(Buffer.alloc(33_600))).toBe(true);
  });

  it("clamps configured realtime trailing silence before allocating audio", async () => {
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              silenceDurationMs: 60_000,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u1",
    );

    turn?.sendInputAudio(Buffer.alloc(3840));
    turn?.close();

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
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u1"],
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          bargeIn: false,
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const player = getLastAudioPlayer();
    const entry = getSessionEntry(manager);
    player.state.status = "playing";

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u1");

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
    let resolveReady!: () => void;
    const readyPromise = new Promise<undefined>((resolve) => {
      resolveReady = () => resolve(undefined);
    });
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    entersStateMock.mockImplementationOnce(async () => readyPromise);
    const manager = createManager();

    const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
    await Promise.resolve();
    const secondJoin = manager.join({ guildId: "g1", channelId: "1001" });
    await Promise.resolve();

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);

    resolveReady();
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
    let resolveFirstReady!: () => void;
    let resolveSecondReady!: () => void;
    let resolveThirdReady!: () => void;
    const firstReady = new Promise<undefined>((resolve) => {
      resolveFirstReady = () => resolve(undefined);
    });
    const secondReady = new Promise<undefined>((resolve) => {
      resolveSecondReady = () => resolve(undefined);
    });
    const thirdReady = new Promise<undefined>((resolve) => {
      resolveThirdReady = () => resolve(undefined);
    });
    joinVoiceChannelMock
      .mockReturnValueOnce(firstConnection)
      .mockReturnValueOnce(secondConnection)
      .mockReturnValueOnce(thirdConnection);
    entersStateMock
      .mockImplementationOnce(async () => firstReady)
      .mockImplementationOnce(async () => secondReady)
      .mockImplementationOnce(async () => thirdReady);
    const manager = createManager();

    const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
    await Promise.resolve();
    const secondJoin = manager.join({ guildId: "g1", channelId: "1002" });
    const thirdJoin = manager.join({ guildId: "g1", channelId: "1003" });
    await Promise.resolve();

    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);

    resolveFirstReady();
    await firstJoin;
    await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
    expect(entersStateMock).toHaveBeenCalledTimes(2);

    resolveSecondReady();
    await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3));
    resolveThirdReady();
    const [secondResult, thirdResult] = await Promise.all([secondJoin, thirdJoin]);

    expect(secondResult.ok).toBe(true);
    expect(thirdResult.ok).toBe(true);
    expect(entersStateMock).toHaveBeenCalledTimes(3);
  });

  it("does not start queued joins after the voice manager is destroyed", async () => {
    const connection = createConnectionMock();
    let resolveReady!: () => void;
    const readyPromise = new Promise<undefined>((resolve) => {
      resolveReady = () => resolve(undefined);
    });
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    entersStateMock.mockImplementationOnce(async () => readyPromise);
    const manager = createManager();

    const firstJoin = manager.join({ guildId: "g1", channelId: "1001" });
    await Promise.resolve();
    const queuedJoin = manager.join({ guildId: "g1", channelId: "1002" });
    await Promise.resolve();

    await manager.destroy();
    resolveReady();
    const [firstResult, queuedResult] = await Promise.all([firstJoin, queuedJoin]);

    expect(firstResult.ok).toBe(false);
    expect(queuedResult.ok).toBe(false);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("retries an aborted initial voice connection readiness wait", async () => {
    const firstConnection = createConnectionMock();
    const secondConnection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
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
    joinVoiceChannelMock.mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
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
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(manager.status()).toStrictEqual([]);
  });

  it("uses the default reconnect grace before destroying disconnected sessions", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    entersStateMock.mockClear();
    entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
    entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

    const disconnected = connection.handlers.get("disconnected");
    expect(disconnected).toBeTypeOf("function");
    await disconnected?.();

    expect(entersStateMock).toHaveBeenCalledWith(connection, "signalling", 15_000);
    expect(entersStateMock).toHaveBeenCalledWith(connection, "connecting", 15_000);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(manager.status()).toStrictEqual([]);
  });

  it("closes realtime sessions when disconnected recovery destroys the connection", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    entersStateMock.mockClear();
    entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));
    entersStateMock.mockRejectedValueOnce(new Error("still disconnected"));

    const disconnected = connection.handlers.get("disconnected");
    expect(disconnected).toBeTypeOf("function");
    await disconnected?.();

    expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(manager.status()).toStrictEqual([]);
  });

  it("closes realtime sessions when Discord destroys the connection", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const destroyed = connection.handlers.get("destroyed");
    expect(destroyed).toBeTypeOf("function");
    destroyed?.();

    expect(realtimeSessionMock.close).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(manager.status()).toStrictEqual([]);
  });

  it("uses agent-proxy realtime voice by default", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "agent proxy answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        model: "openai/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          speakerVoice: "cedar",
          debounceMs: 1,
        },
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(true);
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | {
          realtime?: {
            beginSpeakerTurn: (
              context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
              userId: string,
            ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
          };
        }
      | undefined;
    const ownerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    const providerOptions = requireRecord(
      lastMockCall(
        resolveConfiguredRealtimeVoiceProviderMock as unknown as MockCallSource,
        "provider resolve",
      )[0],
      "provider resolve options",
    );
    expect(providerOptions.configuredProviderId).toBe("openai");
    expect(providerOptions.defaultModel).toBe("gpt-realtime-2");
    expect(providerOptions.providerConfigOverrides).toEqual({
      model: "gpt-realtime-2",
      voice: "cedar",
    });
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          autoRespondToAudio?: boolean;
          instructions?: string;
          tools?: Array<{ name: string }>;
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;
    expect(bridgeParams?.autoRespondToAudio).toBe(false);
    expect(bridgeParams?.instructions).toContain("same OpenClaw agent");
    expect(bridgeParams?.instructions).toContain("short natural backchannel");
    expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");
    expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_control");
    const player = getLastAudioPlayer();
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
    expect(player.play).toHaveBeenCalled();
    const stopCallsBeforeConsult = player.stop.mock.calls.length;

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "what did I ask?" },
      },
      realtimeSessionMock,
    );
    expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeConsult);
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
        text: "agent proxy answer",
      }),
    );

    const commandArgs = lastAgentCommandArgs();
    expect(commandArgs.model).toBe("openai/gpt-5.5");
    expect(commandArgs.messageProvider).toBe("discord-voice");
    expect(commandArgs.toolsAllow).toBeUndefined();
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
  });

  it("handles semantic realtime agent-control tool calls in Discord VC", async () => {
    controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
      ok: true,
      mode: "steer",
      sessionKey: "discord:g1:c1",
      sessionId: "embedded-active",
      active: true,
      queued: true,
      target: "embedded_run",
      message: "Got it. I steered the active run.",
      speak: true,
      show: true,
      suppress: false,
    });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-control",
        callId: "call-control",
        name: "openclaw_agent_control",
        args: { text: "revísalo en WebUI", mode: "steer" },
      },
      realtimeSessionMock,
    );

    await vi.waitFor(() =>
      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "revísalo en WebUI",
        mode: "steer",
      }),
    );
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-control",
        expect.objectContaining({ mode: "steer", queued: true }),
      ),
    );
  });

  it("does not require speaker context for internal exact-speech consults", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-exact",
        callId: "call-exact",
        name: "openclaw_agent_consult",
        args: {
          question: "Speak the provided exact answer verbatim to the Discord voice channel.",
          context: 'Provided answer text: "already answered"\\nSpoken style: verbatim only',
        },
      },
      realtimeSessionMock,
    );
    bridgeParams?.onToolCall?.(
      {
        itemId: "item-internal",
        callId: "call-internal",
        name: "openclaw_agent_consult",
        args: {
          question: [
            "Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
            'Answer: "direct internal answer"',
          ].join("\n"),
        },
      },
      realtimeSessionMock,
    );

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(2);
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-exact", {
      text: "already answered",
    });
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-internal", {
      text: "direct internal answer",
    });
  });

  it("creates a fresh realtime output stream after the Discord player idles", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(true);
    const player = getLastAudioPlayer() as {
      on: ReturnType<typeof vi.fn>;
      play: ReturnType<typeof vi.fn>;
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    expect(createAudioResourceMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
    const firstStream = lastAudioResourceInput() as { writableEnded?: boolean } | undefined;
    await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));

    const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
      | (() => void)
      | undefined;
    expect(idleHandler).toBeTypeOf("function");
    idleHandler?.();

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    expect(createAudioResourceMock).toHaveBeenCalledTimes(2);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it("clears stale realtime playback when stream close and player idle do not fire", async () => {
    vi.useFakeTimers();
    try {
      const manager = createManager({
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai" },
        },
      });

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      const player = getLastAudioPlayer();
      const bridgeParams = lastRealtimeBridgeParams() as
        | {
            audioSink?: {
              sendAudio: (audio: Buffer) => void;
            };
            onEvent?: (event: { direction: "server"; type: string }) => void;
          }
        | undefined;

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const stream = lastAudioResourceInput() as PassThrough | undefined;
      stream?.removeAllListeners("close");

      await vi.advanceTimersByTimeAsync(1_509);
      expect(player.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(player.stop).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old realtime playback watchdog stop a later response", async () => {
    vi.useFakeTimers();
    try {
      const manager = createManager({
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai" },
        },
      });

      await manager.join({ guildId: "g1", channelId: "1001" });

      const player = getLastAudioPlayer();
      const bridgeParams = lastRealtimeBridgeParams() as
        | {
            audioSink?: {
              sendAudio: (audio: Buffer) => void;
            };
            onEvent?: (event: { direction: "server"; type: string }) => void;
          }
        | undefined;

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const firstStream = lastAudioResourceInput() as PassThrough | undefined;
      firstStream?.emit("close");

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      await vi.advanceTimersByTimeAsync(1_510);

      expect(player.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains queued exact speech when stream close arrives without player idle", async () => {
    vi.useFakeTimers();
    try {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const manager = createManager({
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai" },
        },
      });

      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager) as {
        realtime?: {
          beginSpeakerTurn: (
            context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
            userId: string,
          ) => { sendInputAudio: (audio: Buffer) => void };
        };
      };
      const bridgeParams = lastRealtimeBridgeParams() as
        | {
            audioSink?: { sendAudio: (audio: Buffer) => void };
            onEvent?: (event: { direction: "server"; type: string }) => void;
            onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          }
        | undefined;

      const firstTurn = entry.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
        "u-owner",
      );
      firstTurn?.sendInputAudio(Buffer.alloc(8));
      bridgeParams?.onTranscript?.("user", "first question", true);
      await vi.advanceTimersByTimeAsync(260);
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      const secondTurn = entry.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
        "u-owner",
      );
      secondTurn?.sendInputAudio(Buffer.alloc(8));
      bridgeParams?.onTranscript?.("user", "second question", true);
      await vi.advanceTimersByTimeAsync(260);
      expectUserMessageNotIncludes("second answer");

      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const firstStream = lastAudioResourceInput() as PassThrough | undefined;
      firstStream?.emit("close");

      await vi.advanceTimersByTimeAsync(1_510);
      expectUserMessageIncludes("second answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prebuffers realtime output before starting Discord playback", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const player = getLastAudioPlayer();
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    for (let index = 0; index < 49; index += 1) {
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    }

    expect(createAudioResourceMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
  });

  it("discards prebuffered realtime output when the response is cancelled", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    const player = getLastAudioPlayer();
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { detail?: string; direction: "server"; type: string }) => void;
        }
      | undefined;

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    bridgeParams?.onEvent?.({ direction: "server", type: "response.cancelled" });

    expect(createAudioResourceMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalledWith(true);

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    bridgeParams?.onEvent?.({
      detail: "response completed with status=cancelled",
      direction: "server",
      type: "response.done",
    });

    expect(createAudioResourceMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalledTimes(2);
  });

  it("applies Discord realtime model and voice overrides during provider auto-selection", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: {
          model: "gpt-realtime-2",
          speakerVoiceId: "cedar",
          minBargeInAudioEndMs: 500,
          providers: {
            openai: { model: "provider-default", voice: "marin" },
          },
        },
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(true);
    const providerOptions = requireRecord(
      lastMockCall(
        resolveConfiguredRealtimeVoiceProviderMock as unknown as MockCallSource,
        "provider resolve",
      )[0],
      "provider resolve options",
    );
    expect(providerOptions.configuredProviderId).toBeUndefined();
    expect(providerOptions.defaultModel).toBe("gpt-realtime-2");
    expect(requireRecord(providerOptions.providerConfigs, "provider configs").openai).toEqual({
      model: "provider-default",
      voice: "marin",
    });
    expect(providerOptions.providerConfigOverrides).toEqual({
      model: "gpt-realtime-2",
      voice: "cedar",
      minBargeInAudioEndMs: 500,
    });
  });

  it("keeps agent-proxy realtime transcripts on the audio turn speaker context", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "non-owner answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai", debounceMs: 1 },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | {
          realtime?: {
            beginSpeakerTurn: (
              context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
              userId: string,
            ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
          };
        }
      | undefined;
    const nonOwnerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    nonOwnerTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;
    bridgeParams?.onTranscript?.("user", "non-owner question", true);
    const ownerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expectUserMessageIncludes("non-owner answer");
  });

  it("routes active-run realtime transcripts to voice control before forced consults", async () => {
    controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
      ok: true,
      mode: "cancel",
      sessionKey: "discord:g1:c1",
      sessionId: "embedded-active",
      active: true,
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      show: true,
      suppress: false,
    });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const player = getLastAudioPlayer();
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.onTranscript?.("user", "cancel that", true);

    await vi.waitFor(() =>
      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "cancel that",
      }),
    );
    expect(agentCommandMock).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledWith({
        audioPlaybackActive: true,
        force: true,
      }),
    );
    await vi.waitFor(() => expectUserMessageIncludes("Cancelled the active OpenClaw run."));
    expect(textToSpeechMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "Cancelled the active OpenClaw run." }),
    );

    const stopCallsAfterControl = player.stop.mock.calls.length;
    bridgeParams?.onTranscript?.("assistant", "Cancelled the active OpenClaw run.", true);
    expect(player.stop).toHaveBeenCalledTimes(stopCallsAfterControl);
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
    bridgeParams?.onTranscript?.("assistant", "Cancelled the active OpenClaw run.", true);
    expect(player.stop).toHaveBeenCalledTimes(stopCallsAfterControl + 1);
  });

  it("preserves realtime forced consults when no active run accepts steering", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "normal answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.onTranscript?.("user", "normal question", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(lastAgentCommandArgs().message).toContain("normal question");
    expectUserMessageIncludes("normal answer");
  });

  it("requires the agent wake name before realtime agent-proxy consults", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          autoRespondToAudio?: boolean;
          interruptResponseOnInputAudio?: boolean;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    expect(bridgeParams?.autoRespondToAudio).toBe(false);
    expect(bridgeParams?.interruptResponseOnInputAudio).toBe(false);
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(48_000));

    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "agent-1 how is it going", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Hey, Molty, how is it going", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
      sessionKey: "discord:g1:c1",
      text: "how is it going",
    });
    expect(lastAgentCommandArgs().message).toContain("how is it going");
    expect(lastAgentCommandArgs().message).not.toContain("Molty");
    expect(lastAgentCommandArgs().message).not.toContain("Hey");
  });

  it("acknowledges leading wake names from partial realtime transcripts", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onEvent?: (event: { direction: "server"; type: string }) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    bridgeParams?.onTranscript?.("user", "Hey, Molty", false);

    expectUserMessageIncludes('Answer: "Yeah."');
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();

    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    bridgeParams?.onTranscript?.("user", "Hey, Molty, how is it going", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
      sessionKey: "discord:g1:c1",
      text: "how is it going",
    });
    expect(lastAgentCommandArgs().message).toContain("how is it going");
    expectUserMessageIncludes("wake answer");
  });

  it("treats a bare wake name as an activation for the next realtime transcript", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "follow-up answer" }] });
    const onUtterance = vi.fn();
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.join(
      { guildId: "g1", channelId: "1001" },
      {
        transcripts: {
          sessionId: "notes-1",
          onUtterance,
        },
      },
    );
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: "owner prompt", senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Multy?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();

    bridgeParams?.onTranscript?.("user", "What's your take on rebuilding everything?", true);

    await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
    expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
    expect(lastAgentCommandArgs().message).toContain("What's your take on rebuilding everything?");
    expect(lastAgentCommandArgs().message).not.toContain("Multy");
    expect(lastAgentCommandArgs().extraSystemPrompt).toBe("owner prompt");
    expectUserMessageIncludes("follow-up answer");
    await vi.waitFor(() =>
      expect(onUtterance).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "notes-1",
          text: "What's your take on rebuilding everything?",
          speaker: { id: "u-owner", label: "Owner" },
        }),
      ),
    );
  });

  it("reuses recently ignored speaker context when wake-name consult has no pending turn", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: "owner prompt", senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));

    bridgeParams?.onTranscript?.("user", "room noise", true);
    bridgeParams?.onTranscript?.("user", "Molty, so", true);
    bridgeParams?.onTranscript?.("user", "Malty, what do you have to say?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(lastAgentCommandArgs().message).toContain("what do you have to say?");
    expect(lastAgentCommandArgs().message).not.toContain("Malty");
    expect(lastAgentCommandArgs().extraSystemPrompt).toBe("owner prompt");
    expectUserMessageIncludes("wake answer");
  });

  it("accepts OpenClaw as a default wake name before realtime agent-proxy consults", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "openclaw wake answer" }] });
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "OpenClaw, how is it going", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
      sessionKey: "discord:g1:c1",
      text: "how is it going",
    });
    expect(lastAgentCommandArgs().message).toContain("how is it going");
    expect(lastAgentCommandArgs().message).not.toContain("OpenClaw");
    expectUserMessageIncludes("openclaw wake answer");
  });

  it("ignores default agent wake names longer than two words", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "fallback wake answer" }] });
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Claw Bot Helper" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const longNameTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    longNameTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Claw Bot Helper, should not wake", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).not.toHaveBeenCalled();

    const fallbackTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    fallbackTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "OpenClaw, fallback still wakes", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(lastAgentCommandArgs().message).toContain("fallback still wakes");
    expect(lastAgentCommandArgs().message).not.toContain("OpenClaw");
    expectUserMessageIncludes("fallback wake answer");
  });

  it("accepts leading fuzzy wake names before realtime agent-proxy consults", async () => {
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const montyTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    montyTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Monty, are you with us?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(0).message).toContain("are you with us?");
    expect(agentCommandArgsAt(0).message).not.toContain("Monty");

    const motiTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    motiTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Moti, what's going on today?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(1).message).toContain("what's going on today?");
    expect(agentCommandArgsAt(1).message).not.toContain("Moti");

    const multiTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    multiTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Multi, step through the maintainer queue.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(2).message).toContain("step through the maintainer queue.");
    expect(agentCommandArgsAt(2).message).not.toContain("Multi");

    const martyTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    martyTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Marty, can you hear me?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(3).message).toContain("can you hear me?");
    expect(agentCommandArgsAt(3).message).not.toContain("Marty");

    const openClawTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openClawTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Open claw can you still hear me?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(4).message).toContain("can you still hear me?");
    expect(agentCommandArgsAt(4).message).not.toContain("Open claw");

    const openClubTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openClubTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Open Club, can you hear me now?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(5).message).toContain("can you hear me now?");
    expect(agentCommandArgsAt(5).message).not.toContain("Open Club");

    const openCloudTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openCloudTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Open Cloud, can you hear me too?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(6).message).toContain("can you hear me too?");
    expect(agentCommandArgsAt(6).message).not.toContain("Open Cloud");

    const trailingMoltyTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    trailingMoltyTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Can you still hear trailing, Molty.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(7).message).toContain("Can you still hear trailing");
    expect(agentCommandArgsAt(7).message).not.toContain("Molty");

    const trailingMaltyTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    trailingMaltyTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "What's going on today, Malty?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandArgsAt(8).message).toContain("What's going on today");
    expect(agentCommandArgsAt(8).message).not.toContain("Malty");

    const openChatTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openChatTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Open chat, can you hear me now?", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).toHaveBeenCalledTimes(9);
  });

  it("rejects non-wake fuzzy leading phrases before realtime agent-proxy consults", async () => {
    const manager = createManager(
      {
        groupPolicy: "open",
        voice: {
          enabled: true,
          mode: "agent-proxy",
          realtime: { provider: "openai", consultPolicy: "auto", requireWakeName: true },
        },
      },
      undefined,
      {
        agents: {
          list: [{ id: "agent-1", identity: { name: "Molty" } }],
        },
      },
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const ambientTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ambientTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "This is a multi-step maintainer problem.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const middleWakeWordTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    middleWakeWordTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "I asked multi about this already.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const openLawTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openLawTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Open law is not the wake phrase.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const fuzzyTrailingTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    fuzzyTrailingTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "I miss the nonsensical German ranting from Multy.", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("leaves non-OpenAI agent-proxy realtime auto-response enabled when wake names are requested", async () => {
    resolveConfiguredRealtimeVoiceProviderMock.mockReturnValueOnce({
      provider: { id: "google" },
      providerConfig: { model: "gemini-live", voice: "default" },
    });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "google", consultPolicy: "auto", requireWakeName: true },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          autoRespondToAudio?: boolean;
          interruptResponseOnInputAudio?: boolean;
        }
      | undefined;

    expect(bridgeParams?.autoRespondToAudio).toBe(true);
    expect(bridgeParams?.interruptResponseOnInputAudio).toBe(true);
  });

  it("uses configured wake names before realtime agent-proxy consults", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "configured wake answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: {
          provider: "openai",
          consultPolicy: "auto",
          requireWakeName: true,
          wakeNames: ["Claw", "Claw Bot", "Okay Google"],
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.onTranscript?.("user", "Claw Bot, ship it", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(lastAgentCommandArgs().message).toContain("ship it");
    expect(lastAgentCommandArgs().message).not.toContain("Claw");
    expect(lastAgentCommandArgs().message).not.toContain("Bot");
    expectUserMessageIncludes("configured wake answer");

    const openerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    openerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Okay Google, try the opener name", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(lastAgentCommandArgs().message).toContain("try the opener name");
    expect(lastAgentCommandArgs().message).not.toContain("Okay");
    expect(lastAgentCommandArgs().message).not.toContain("Google");
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
  });

  it("does not accept configured realtime wake names longer than two words", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: {
          provider: "openai",
          consultPolicy: "auto",
          requireWakeName: true,
          wakeNames: ["Claw Bot Helper"],
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.onTranscript?.("user", "Claw Bot Helper, ship it", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    const fallbackTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    fallbackTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "OpenClaw, ship it", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("lets status questions fall back to normal realtime handling when no run is active", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "status answer" }] });
    controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
      ok: true,
      mode: "status",
      sessionKey: "discord:g1:c1",
      active: false,
      message: "I'm not working on an active request right now.",
      speak: true,
      show: true,
      suppress: false,
    });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    bridgeParams?.onTranscript?.("user", "how is it going", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
      sessionKey: "discord:g1:c1",
      text: "how is it going",
    });
    expect(lastAgentCommandArgs().message).toContain("how is it going");
    expectUserMessageIncludes("status answer");
  });

  it("keeps separate forced agent-proxy fallback timers for rapid transcripts", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "owner answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "guest question", true);

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "owner question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

    const guestCommandArgs = agentCommandArgsAt(0);
    expect(guestCommandArgs.message).toContain("guest question");
    const ownerCommandArgs = agentCommandArgsAt(1);
    expect(ownerCommandArgs.message).toContain("owner question");
    expectUserMessageIncludes("guest answer");
    expectUserMessageIncludes("owner answer");
  });

  it("skips incomplete and non-actionable forced agent-proxy transcripts", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "valid answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const incompleteTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    incompleteTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "Get this working and...", true);

    const closingTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    closingTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "I'll be right back. See you guys. Bye-bye.", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(agentCommandMock).not.toHaveBeenCalled();

    const validTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    validTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "ship it.", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(lastAgentCommandArgs().message).toContain("ship it.");
    expectUserMessageIncludes("valid answer");
  });

  it("keeps forced agent-proxy fallback diagnostics out of agent prompts", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "Could you repeat that?" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const turn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    turn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "What?", true);

    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(lastAgentCommandArgs().message).toBe("What?");
    expect(lastAgentCommandArgs().message).not.toContain("consultPolicy");
    expect(lastAgentCommandArgs().message).not.toContain("openclaw_agent_consult");
    expectUserMessageIncludes("Could you repeat that?");
  });

  it("queues forced agent-proxy answers until current realtime playback idles", async () => {
    let resolveFirst: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
    let resolveSecond: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
    let resolveThird: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
    agentCommandMock
      .mockImplementationOnce(
        () =>
          new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
            resolveSecond = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
            resolveThird = resolve;
          }),
      );
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const player = getLastAudioPlayer() as {
      on: ReturnType<typeof vi.fn>;
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          onEvent?: (event: { direction: "server"; type: string }) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const firstTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    firstTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "first question", true);
    const secondTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    secondTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "second question", true);
    const thirdTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    thirdTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "third question", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    resolveFirst?.({ payloads: [{ text: "first answer" }] });
    await vi.waitFor(() => expectUserMessageIncludes("first answer"));
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    resolveSecond?.({ payloads: [{ text: "second answer" }] });
    resolveThird?.({ payloads: [{ text: "third answer" }] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expectUserMessageNotIncludes("second answer");
    expectUserMessageNotIncludes("third answer");

    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    const firstStream = lastAudioResourceInput() as PassThrough | undefined;
    await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expectUserMessageNotIncludes("second answer");

    const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
      | (() => void)
      | undefined;
    idleHandler?.();
    expectUserMessageIncludes("second answer");
    expectUserMessageNotIncludes("third answer");

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    const secondStream = lastAudioResourceInput() as PassThrough | undefined;
    await vi.waitFor(() => expect(secondStream?.writableEnded).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expectUserMessageNotIncludes("third answer");

    idleHandler?.();
    expectUserMessageIncludes("third answer");
  });

  it("does not interrupt active exact speech for a later forced agent-proxy consult", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const player = getLastAudioPlayer();
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          onEvent?: (event: { direction: "server"; type: string }) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const firstTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    firstTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "first question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    await vi.waitFor(() => expectUserMessageIncludes("first answer"));
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    const secondTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    secondTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "second question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(
      realtimeSessionMock.handleBargeIn.mock.calls.some(([arg]) => {
        return (arg as { force?: boolean } | undefined)?.force === true;
      }),
    ).toBe(false);
    expect(player.stop).not.toHaveBeenCalled();
    expectUserMessageNotIncludes("second answer");

    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    const firstStream = lastAudioResourceInput() as PassThrough | undefined;
    await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expectUserMessageNotIncludes("second answer");

    const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
      | (() => void)
      | undefined;
    idleHandler?.();
    expectUserMessageIncludes("second answer");
  });

  it("drains queued exact speech after cancelled prebuffered output is discarded", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const player = getLastAudioPlayer();
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: { sendAudio: (audio: Buffer) => void };
          onEvent?: (event: { detail?: string; direction: "server"; type: string }) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const firstTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    firstTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "first question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    await vi.waitFor(() => expectUserMessageIncludes("first answer"));
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    const secondTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    secondTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "second question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));
    expectUserMessageNotIncludes("second answer");

    bridgeParams?.onEvent?.({ direction: "server", type: "response.cancelled" });

    expect(createAudioResourceMock).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalledWith(true);
    expectUserMessageIncludes("second answer");
  });

  it("matches agent-proxy consult tool calls to the pending transcript", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "owner answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "guest fallback answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "guest question", true);

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "owner question", true);

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-owner",
        callId: "call-owner",
        name: "openclaw_agent_consult",
        args: { question: "owner question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 260));

    const ownerCommandArgs = agentCommandArgsAt(0);
    expect(ownerCommandArgs.message).toContain("owner question");
    const guestCommandArgs = agentCommandArgsAt(1);
    expect(guestCommandArgs.message).toContain("guest question");
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-owner", {
      text: "owner answer",
    });
    expectUserMessageIncludes("guest fallback answer");
  });

  it("reuses forced agent-proxy answers for late matching consult tool calls", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "forced answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "late question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-late",
        callId: "call-late",
        name: "openclaw_agent_consult",
        args: { question: "late question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectUserMessageIncludes("forced answer");
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
      "call-late",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this answer to Discord voice.",
      },
      { suppressResponse: true },
    );
  });

  it("suppresses late forced agent-proxy tool calls when the forced consult rejects", async () => {
    let rejectAgentTurn: ((error: unknown) => void) | undefined;
    agentCommandMock.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectAgentTurn = reject;
      }),
    );
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "late question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-late",
        callId: "call-late",
        name: "openclaw_agent_consult",
        args: { question: "late question" },
      },
      realtimeSessionMock,
    );
    rejectAgentTurn?.(new Error("agent broke"));
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-late",
        {
          status: "already_delivered",
          message: "OpenClaw already delivered this answer to Discord voice.",
        },
        { suppressResponse: true },
      ),
    );

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectUserMessageIncludes("I hit an error while checking that. Please try again.");
  });

  it("does not reuse recent agent-proxy answers over newer speaker audio", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "forced answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "late question", true);

    await new Promise((resolve) => setTimeout(resolve, 260));

    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-late",
        callId: "call-late",
        name: "openclaw_agent_consult",
        args: { question: "late question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectUserMessageIncludes("forced answer");
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-late", {
      error: "Discord speaker context changed before this realtime consult completed",
    });
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

    bridgeParams?.onTranscript?.("user", "guest followup", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    const followupCommandArgs = agentCommandArgsAt(1);
    expect(followupCommandArgs.message).toContain("guest followup");
    expectUserMessageIncludes("guest answer");
  });

  it("prefers the newest recent agent-proxy consult for repeated questions", async () => {
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "old direct answer" }] })
      .mockResolvedValueOnce({ payloads: [{ text: "new forced answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;

    const firstTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    firstTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onToolCall?.(
      {
        itemId: "item-old",
        callId: "call-old",
        name: "openclaw_agent_consult",
        args: { question: "repeat question" },
      },
      realtimeSessionMock,
    );
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-old", {
        text: "old direct answer",
      }),
    );

    const secondTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    secondTurn?.sendInputAudio(Buffer.alloc(8));
    bridgeParams?.onTranscript?.("user", "repeat question", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-new",
        callId: "call-new",
        name: "openclaw_agent_consult",
        args: { question: "repeat question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expectUserMessageIncludes("new forced answer");
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
      "call-new",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this answer to Discord voice.",
      },
      { suppressResponse: true },
    );
    expect(realtimeSessionMock.submitToolResult).not.toHaveBeenCalledWith("call-new", {
      text: "old direct answer",
    });
  });

  it("expires closed agent-proxy turns before later speaker audio", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai", debounceMs: 1 },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    ownerTurn?.close();
    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    bridgeParams?.onTranscript?.("user", "guest question", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expectUserMessageIncludes("guest answer");
  });

  it("starts Discord realtime voice in bidi mode with the consult tool", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "consult answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
          requireWakeName: true,
          providers: {
            openai: {
              interruptResponseOnInputAudio: false,
            },
          },
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | {
          realtime?: {
            beginSpeakerTurn: (
              context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
              userId: string,
            ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
          };
        }
      | undefined;
    const ownerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          autoRespondToAudio?: boolean;
          interruptResponseOnInputAudio?: boolean;
          instructions?: string;
          tools?: Array<{ name: string }>;
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;
    expect(bridgeParams?.autoRespondToAudio).toBe(true);
    expect(bridgeParams?.interruptResponseOnInputAudio).toBe(false);
    expect(bridgeParams?.instructions).toContain("Call openclaw_agent_consult");
    expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "check my Discord" },
      },
      realtimeSessionMock,
    );
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
        text: "consult answer",
      }),
    );

    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
    const commandArgs = lastAgentCommandArgs();
    expect(commandArgs.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
  });

  it("adds default bootstrap profile context to realtime voice instructions", async () => {
    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1001",
    });
    resolveRealtimeBootstrapContextInstructionsMock.mockResolvedValue(
      "OpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Wilfred",
    );
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          consultPolicy: "always",
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(resolveRealtimeBootstrapContextInstructionsMock).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1001",
      files: undefined,
      warn: expect.any(Function),
    });
    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          instructions?: string;
        }
      | undefined;
    expect(bridgeParams?.instructions).toContain("OpenClaw realtime voice profile context");
    expect(bridgeParams?.instructions).toContain("Name: Wilfred");
    expect(bridgeParams?.instructions).toContain("short natural backchannel");
    expect(bridgeParams?.instructions).toContain("Call openclaw_agent_consult");
  });

  it("routes bidi realtime consults through a configured voice agent session target", async () => {
    resolveAgentRouteMock.mockImplementation((params?: { peer?: { id?: string } }) => {
      if (params?.peer?.id === "maintainers") {
        return {
          agentId: "main",
          sessionKey: "agent:main:discord:channel:maintainers",
        };
      }
      return {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:1001",
      };
    });
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "maintainer answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        agentSession: {
          mode: "target",
          target: "channel:maintainers",
        },
        realtime: {
          provider: "openai",
          consultPolicy: "always",
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
      route?: { sessionKey?: string };
      voiceSessionKey?: string;
    };
    expect(entry.voiceSessionKey).toBe("agent:main:discord:channel:1001");
    expect(entry.route?.sessionKey).toBe("agent:main:discord:channel:maintainers");

    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;
    bridgeParams?.onToolCall?.(
      {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "check the maintainer channel context" },
      },
      realtimeSessionMock,
    );
    await vi.waitFor(() =>
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
        text: "maintainer answer",
      }),
    );

    expect(lastAgentCommandArgs().sessionKey).toBe("agent:main:discord:channel:maintainers");
  });

  it("keeps bidi realtime consults on the audio turn speaker context", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest consult answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | {
          realtime?: {
            beginSpeakerTurn: (
              context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
              userId: string,
            ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
          };
        }
      | undefined;
    const nonOwnerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    nonOwnerTurn?.sendInputAudio(Buffer.alloc(8));
    const ownerTurn = entry?.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;
    bridgeParams?.onToolCall?.(
      {
        itemId: "item-guest",
        callId: "call-guest",
        name: "openclaw_agent_consult",
        args: { question: "guest question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();

    const commandArgs = lastAgentCommandArgs();
    expect(commandArgs.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
  });

  it("expires closed bidi turns before later speaker consults", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest consult answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        realtime: {
          provider: "openai",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
        },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      realtime?: {
        beginSpeakerTurn: (
          context: { extraSystemPrompt?: string; senderIsOwner: boolean; speakerLabel: string },
          userId: string,
        ) => { close: () => void; sendInputAudio: (audio: Buffer) => void };
      };
    };
    const ownerTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
      "u-owner",
    );
    ownerTurn?.sendInputAudio(Buffer.alloc(8));
    ownerTurn?.close();
    const guestTurn = entry.realtime?.beginSpeakerTurn(
      { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
      "u-guest",
    );
    guestTurn?.sendInputAudio(Buffer.alloc(8));

    const bridgeParams = lastRealtimeBridgeParams() as
      | {
          onToolCall?: (
            event: {
              itemId: string;
              callId: string;
              name: string;
              args: unknown;
            },
            session: typeof realtimeSessionMock,
          ) => void;
        }
      | undefined;
    bridgeParams?.onToolCall?.(
      {
        itemId: "item-guest",
        callId: "call-guest",
        name: "openclaw_agent_consult",
        args: { question: "guest question" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();

    const commandArgs = lastAgentCommandArgs();
    expect(commandArgs.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
  });

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
    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | {
          player: { state: { status: string } };
        }
      | undefined;
    if (!entry) {
      throw new Error("expected voice session for guild g1");
    }
    expect(entry.player.state.status).toBe("idle");
    entry.player.state.status = "playing";

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-denied");

    expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(client.fetchMember).toHaveBeenCalledWith("g1", "u-denied");
  });

  it("stores guild metadata on joined voice sessions", async () => {
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    const entry = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get("g1") as
      | { guildName?: string }
      | undefined;
    expect(entry?.guildName).toBe("Guild One");
  });

  it("enables DAVE receive passthrough after join", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 30);
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
    const manager = createManager({
      voice: {
        enabled: true,
        mode: "stt-tts",
        followUsers: ["u-owner"],
      },
    });

    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    } as never);

    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    emitDecryptFailure(manager);

    await vi.waitFor(() => {
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    });
    await manager.handleVoiceStateUpdate({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: null,
    } as never);

    expect(manager.status()).toEqual([]);
  });

  it("resets DAVE receive recovery after realtime audio decodes", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    decodeOpusStreamChunksMock.mockImplementationOnce(
      async (
        _stream: Readable,
        params: {
          onChunk: (pcm48kStereo: Buffer) => void;
        },
      ) => {
        params.onChunk(Buffer.alloc(8));
      },
    );
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u-speaker"],
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    emitDecryptFailure(manager);
    emitDecryptFailure(manager);
    const entry = getSessionEntry(manager) as {
      receiveRecovery: { decryptFailureCount: number; lastDecryptFailureAt: number };
    };
    expect(entry.receiveRecovery.decryptFailureCount).toBe(2);
    const stream = {
      on: vi.fn(),
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    };
    connection.receiver.subscribe.mockReturnValueOnce(stream);

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-speaker");

    expect(decodeOpusStreamChunksMock).toHaveBeenCalledTimes(1);
    expect(entry.receiveRecovery.decryptFailureCount).toBe(0);
    expect(entry.receiveRecovery.lastDecryptFailureAt).toBe(0);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up realtime receive streams after WASM bounds failures", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    decodeOpusStreamChunksMock.mockImplementationOnce(
      async (
        stream: Readable,
        params: {
          onError: (err: unknown) => void;
        },
      ) => {
        const err = new Error("memory access out of bounds");
        params.onError(err);
        const errorListener = (
          stream as unknown as {
            on: ReturnType<typeof vi.fn>;
          }
        ).on.mock.calls.find(([event]) => event === "error")?.[1] as
          | ((err: unknown) => void)
          | undefined;
        errorListener?.(err);
      },
    );
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u-speaker"],
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: { provider: "openai" },
      },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      capture: {
        activeSpeakers: Set<string>;
        activeCaptureStreams: Map<string, unknown>;
      };
      receiveRecovery: { decryptFailureCount: number };
    };
    const stream = {
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
      destroyed: false,
      async *[Symbol.asyncIterator]() {},
    };
    connection.receiver.subscribe.mockReturnValueOnce(stream);

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-speaker");

    const errorListener = stream.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(errorListener).toBeTypeOf("function");
    expect(stream.off).toHaveBeenCalledWith("error", errorListener);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(entry.capture.activeSpeakers.has("u-speaker")).toBe(false);
    expect(entry.capture.activeCaptureStreams.has("u-speaker")).toBe(false);
    expect(entry.receiveRecovery.decryptFailureCount).toBe(1);
  });

  it("keeps receive recovery state after non-realtime decoder failures", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    decodeOpusStreamMock.mockImplementationOnce(
      async (
        _stream: Readable,
        params: {
          onError: (err: unknown) => void;
        },
      ) => {
        params.onError(new Error("memory access out of bounds"));
        return Buffer.alloc(8);
      },
    );
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u-speaker"],
      voice: { enabled: true, mode: "stt-tts" },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      receiveRecovery: { decryptFailureCount: number; lastDecryptFailureAt: number };
    };
    const stream = {
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
      destroyed: false,
      async *[Symbol.asyncIterator]() {},
    };
    connection.receiver.subscribe.mockReturnValueOnce(stream);

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-speaker");

    expect(transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(entry.receiveRecovery.decryptFailureCount).toBe(1);
    expect(entry.receiveRecovery.lastDecryptFailureAt).toBeGreaterThan(0);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it("processes partial non-realtime audio after abort-like stream endings", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    decodeOpusStreamMock.mockImplementationOnce(
      async (
        _stream: Readable,
        params: {
          onError: (err: unknown) => void;
        },
      ) => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        params.onError(err);
        return Buffer.alloc(48_000);
      },
    );
    const manager = createManager({
      groupPolicy: "open",
      allowFrom: ["discord:u-speaker"],
      voice: { enabled: true, mode: "stt-tts" },
    });

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = getSessionEntry(manager) as {
      receiveRecovery: { decryptFailureCount: number };
      processingQueue: Promise<void>;
    };
    const stream = {
      on: vi.fn(),
      off: vi.fn(),
      destroy: vi.fn(),
      destroyed: false,
      async *[Symbol.asyncIterator]() {},
    };
    connection.receiver.subscribe.mockReturnValueOnce(stream);

    await (
      manager as unknown as {
        handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
      }
    ).handleSpeakingStart(entry, "u-speaker");
    await entry.processingQueue;

    expect(transcribeAudioFileMock).toHaveBeenCalledTimes(1);
    expect(entry.receiveRecovery.decryptFailureCount).toBe(0);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  it("allows the same speaker to restart after finalize fires", async () => {
    vi.useFakeTimers();
    try {
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const manager = createManager();

      await manager.join({ guildId: "g1", channelId: "1001" });

      const entry = getSessionEntry(manager) as {
        guildId: string;
        channelId: string;
        capture: {
          activeSpeakers: Set<string>;
          activeCaptureStreams: Map<
            string,
            { generation: number; stream: { destroy: () => void } }
          >;
          captureFinalizeTimers: Map<string, unknown>;
          captureGenerations: Map<string, number>;
        };
      };

      const firstStream = { destroy: vi.fn() };
      entry.capture.activeSpeakers.add("u1");
      entry.capture.captureGenerations.set("u1", 1);
      entry.capture.activeCaptureStreams.set("u1", { generation: 1, stream: firstStream });

      (
        manager as unknown as {
          scheduleCaptureFinalize: (entry: unknown, userId: string, reason: string) => void;
        }
      ).scheduleCaptureFinalize(entry, "u1", "test");

      await vi.advanceTimersByTimeAsync(2_500);

      expect(firstStream.destroy).toHaveBeenCalledTimes(1);
      expect(entry?.capture.activeSpeakers.has("u1")).toBe(false);

      const secondStream = {
        on: vi.fn(),
        destroy: vi.fn(),
        async *[Symbol.asyncIterator]() {},
      };
      connection.receiver.subscribe.mockReturnValueOnce(secondStream);

      await (
        manager as unknown as {
          handleSpeakingStart: (entry: unknown, userId: string) => Promise<void>;
        }
      ).handleSpeakingStart(entry, "u1");

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
      entry.capture.activeSpeakers.add("u1");
      entry.capture.captureGenerations.set("u1", 1);
      entry.capture.activeCaptureStreams.set("u1", {
        generation: 1,
        stream: stream as unknown as Readable,
      });

      (
        manager as unknown as {
          scheduleCaptureFinalize: (entry: unknown, userId: string, reason: string) => void;
        }
      ).scheduleCaptureFinalize(entry, "u1", "test");

      await vi.advanceTimersByTimeAsync(3_999);
      expect(stream.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(stream.destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts allowlisted voice speakers", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        id: "u-owner",
        username: "owner",
        globalName: "Owner",
        discriminator: "1234",
      },
    });
    const manager = createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client);
    await processVoiceSegment(manager, "u-owner");
  });

  it("accepts open-policy voice speakers", async () => {
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
    const manager = createManager({ groupPolicy: "open", allowFrom: ["discord:u-owner"] }, client, {
      commands: { useAccessGroups: false },
    });
    await processVoiceSegment(manager, "u-guest");
  });

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
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Owner Nick",
      user: {
        id: "u-owner",
        username: "owner",
        globalName: "Owner",
        discriminator: "1234",
      },
    });
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
        isStopped: () => false,
        stop: vi.fn(),
      } as unknown as Parameters<typeof segmentModule.processDiscordVoiceSegment>[0]["entry"],
      wavPath: "/tmp/test.wav",
      userId: "u-owner",
      durationSeconds: 1.2,
      cfg: {},
      discordConfig,
      ownerAllowFrom: ["discord:u-owner"],
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
        voice: {
          model: "openai/gpt-5.4-mini",
        },
      },
      client,
      {
        commands: { useAccessGroups: false },
      },
    );
    await processVoiceSegment(manager, "u-guest");

    const commandArgs = lastAgentCommandArgs() as
      | { allowModelOverride?: boolean; model?: string }
      | undefined;

    expect(commandArgs?.allowModelOverride).toBe(true);
    expect(commandArgs?.model).toBe("openai/gpt-5.4-mini");
  });

  it("runs voice replies under Discord voice output policy", async () => {
    agentCommandMock.mockResolvedValueOnce({
      payloads: [{ text: "hello back" }],
    } as never);

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
    const manager = createManager({ groupPolicy: "open" }, client, {
      commands: { useAccessGroups: false },
    });
    await processVoiceSegment(manager, "u-guest");

    const commandArgs = lastAgentCommandArgs() as
      | { message?: string; messageChannel?: string; messageProvider?: string }
      | undefined;

    expect(commandArgs?.messageChannel).toBe("discord");
    expect(commandArgs?.messageProvider).toBe("discord-voice");
    expect(commandArgs?.message).toContain("Do not call the tts tool");
    expect(commandArgs?.message).toContain("repair obvious transcription artifacts");
    expect(lastTtsArgs().channel).toBe("discord");
    expect(lastTtsArgs().text).toBe("hello back");
  });

  it("logs a bounded inbound transcript preview for voice debugging", async () => {
    transcribeAudioFileMock.mockResolvedValueOnce({
      text: `hello from voice\n\n${"x".repeat(700)}`,
    });
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Debug Speaker",
      user: {
        id: "u-debug",
        username: "debug",
        globalName: "Debug",
        discriminator: "0001",
      },
    });
    const manager = createManager({ groupPolicy: "open" }, client, {
      commands: { useAccessGroups: false },
    });

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
    const manager = createManager({ groupPolicy: "open" }, client, {
      commands: { useAccessGroups: false },
    });
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

  it("passes per-channel system prompt context to voice agent runs", async () => {
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
      {
        commands: { useAccessGroups: false },
      },
    );
    await processVoiceSegment(manager, "u-guest");

    const commandArgs = lastAgentCommandArgs() as { extraSystemPrompt?: string } | undefined;

    expect(commandArgs?.extraSystemPrompt).toBe("Use short voice replies.");
  });

  it("reuses speaker context cache for repeated segments from the same speaker", async () => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname: "Cached Speaker",
      user: {
        id: "u-cache",
        username: "cache",
        globalName: "Cache",
        discriminator: "1111",
      },
    });
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
});
