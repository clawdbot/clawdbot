import { PassThrough, type Readable } from "node:stream";
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
  transcribeAudioFileMock,
  textToSpeechStreamMock,
  textToSpeechMock,
  logVerboseMock,
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  realtimeSessionMock,
  decodeOpusStreamChunksMock,
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
          destroy: vi.fn(),
          [Symbol.asyncIterator]: async function* () {},
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
    realtimeSessionMock,
    decodeOpusStreamChunksMock: vi.fn(),
  };
});

vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    EndBehaviorType: { AfterSilence: "AfterSilence", Manual: "Manual" },
    NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
    StreamType: { Raw: "raw" },
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
    resolveConfiguredRealtimeVoiceProvider: resolveConfiguredRealtimeVoiceProviderMock,
  };
});

vi.mock("./audio.js", async () => {
  const actual = await vi.importActual<typeof import("./audio.js")>("./audio.js");
  return {
    ...actual,
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

function createClient() {
  return {
    fetchChannel: vi.fn(async (channelId: string) => ({
      id: channelId,
      guildId: "g1",
      guild: { id: "g1", name: "Guild One" },
      type: ChannelType.GuildVoice,
    })),
    fetchGuild: vi.fn(async (guildId: string) => ({
      id: guildId,
      name: "Guild One",
    })),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
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
    managerModule = await import("./manager.js");
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
    transcribeAudioFileMock.mockReset();
    transcribeAudioFileMock.mockResolvedValue({ text: "hello from voice" });
    textToSpeechStreamMock.mockReset();
    textToSpeechStreamMock.mockResolvedValue({ success: false, error: "stream unavailable" });
    textToSpeechMock.mockReset();
    textToSpeechMock.mockResolvedValue({ success: true, audioPath: "/tmp/voice.mp3" });
    logVerboseMock.mockClear();
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
    resolveConfiguredRealtimeVoiceProviderMock.mockClear();
    resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    });
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

    await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject({
      ok: false,
      message: "Discord voice is disabled (channels.discord.voice.enabled).",
    });

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
    expect(joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g1",
        channelId: "1002",
      }),
    );
    expectConnectedStatus(manager, "1002");
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

    await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject({
      ok: true,
    });

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

    await expect(manager.leave({ guildId: "g1" })).resolves.toMatchObject({ ok: true });
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it("removes voice listeners on leave", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    await manager.leave({ guildId: "g1" });

    const player = createAudioPlayerMock.mock.results[0]?.value;
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("start", expect.any(Function));
    expect(connection.receiver.speaking.off).toHaveBeenCalledWith("end", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(player.off).toHaveBeenCalledWith("error", expect.any(Function));
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
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
    expect(connection.receiver.subscribe).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ end: expect.any(Object) }),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
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

    expect(joinVoiceChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daveEncryption: false,
        decryptionFailureTolerance: 8,
      }),
    );
  });

  it("uses the default timeout for initial voice connection readiness", async () => {
    const connection = createConnectionMock();
    joinVoiceChannelMock.mockReturnValueOnce(connection);
    const manager = createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });

    expect(entersStateMock).toHaveBeenCalledWith(connection, "ready", 30_000);
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

    expect(entersStateMock).toHaveBeenCalledWith(connection, "ready", 45_000);

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
        model: "openai-codex/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
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
    expect(resolveConfiguredRealtimeVoiceProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProviderId: "openai",
        defaultModel: "gpt-realtime-2",
        providerConfigOverrides: { model: "gpt-realtime-2", voice: "cedar" },
      }),
    );
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
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
    expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");

    bridgeParams?.onToolCall?.(
      {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "what did I ask?" },
      },
      realtimeSessionMock,
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai-codex/gpt-5.5",
        messageProvider: "discord-voice",
        toolsAllow: undefined,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ status: "working" }),
      { willContinue: true },
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
      text: "agent proxy answer",
    });
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          audioSink?: {
            sendAudio: (audio: Buffer) => void;
          };
          onEvent?: (event: { direction: "server"; type: string }) => void;
        }
      | undefined;

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
    expect(player.play).toHaveBeenCalledTimes(1);
    const firstStream = createAudioResourceMock.mock.calls.at(-1)?.[0] as
      | { writableEnded?: boolean }
      | undefined;
    expect(firstStream?.writableEnded).toBe(false);
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    expect(firstStream?.writableEnded).toBe(true);

    const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
      | (() => void)
      | undefined;
    expect(idleHandler).toBeTypeOf("function");
    idleHandler?.();

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    expect(createAudioResourceMock).toHaveBeenCalledTimes(2);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it("applies Discord realtime model and voice overrides during provider auto-selection", async () => {
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "agent-proxy",
        realtime: {
          model: "gpt-realtime-2",
          voice: "cedar",
          minBargeInAudioEndMs: 500,
          providers: {
            openai: { model: "provider-default", voice: "marin" },
          },
        },
      },
    });

    const result = await manager.join({ guildId: "g1", channelId: "1001" });

    expect(result.ok).toBe(true);
    expect(resolveConfiguredRealtimeVoiceProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProviderId: undefined,
        defaultModel: "gpt-realtime-2",
        providerConfigs: expect.objectContaining({
          openai: { model: "provider-default", voice: "marin" },
        }),
        providerConfigOverrides: {
          model: "gpt-realtime-2",
          voice: "cedar",
          minBargeInAudioEndMs: 500,
        },
      }),
    );
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("non-owner answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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

    expect(agentCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: expect.stringContaining("guest question"),
        senderIsOwner: false,
      }),
      expect.anything(),
    );
    expect(agentCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("owner question"),
        senderIsOwner: true,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("guest answer"),
    );
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("owner answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ship it.") }),
      expect.anything(),
    );
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("valid answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    await vi.waitFor(() =>
      expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("first answer"),
      ),
    );
    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

    resolveSecond?.({ payloads: [{ text: "second answer" }] });
    resolveThird?.({ payloads: [{ text: "third answer" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("second answer"),
    );
    expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("third answer"),
    );

    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    const firstStream = createAudioResourceMock.mock.calls.at(-1)?.[0] as PassThrough | undefined;
    await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("second answer"),
    );

    const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
      | (() => void)
      | undefined;
    idleHandler?.();
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("second answer"),
    );
    expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("third answer"),
    );

    bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    const secondStream = createAudioResourceMock.mock.calls.at(-1)?.[0] as PassThrough | undefined;
    await vi.waitFor(() => expect(secondStream?.writableEnded).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("third answer"),
    );

    idleHandler?.();
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("third answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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

    expect(agentCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: expect.stringContaining("owner question"),
        senderIsOwner: true,
      }),
      expect.anything(),
    );
    expect(agentCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("guest question"),
        senderIsOwner: false,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-owner", {
      text: "owner answer",
    });
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("guest fallback answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("forced answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("I hit an error while checking that. Please try again."),
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
      "call-late",
      {
        status: "already_delivered",
        message: "OpenClaw already delivered this answer to Discord voice.",
      },
      { suppressResponse: true },
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("forced answer"),
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-late", {
      error: "Discord speaker context changed before this realtime consult completed",
    });
    bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

    bridgeParams?.onTranscript?.("user", "guest followup", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(agentCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining("guest followup"),
        senderIsOwner: false,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("guest answer"),
    );
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
    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-old", {
      text: "old direct answer",
    });

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
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("new forced answer"),
    );
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    bridgeParams?.onTranscript?.("user", "guest question", true);
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("guest answer"),
    );
  });

  it("starts Discord realtime voice in bidi mode with the consult tool", async () => {
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "consult answer" }] });
    const manager = createManager({
      groupPolicy: "open",
      voice: {
        enabled: true,
        mode: "bidi",
        model: "openai-codex/gpt-5.5",
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          voice: "cedar",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ status: "working" }),
      { willContinue: true },
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
      text: "consult answer",
    });
    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: true,
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
      expect.anything(),
    );
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:maintainers",
      }),
      expect.anything(),
    );
    expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
      text: "maintainer answer",
    });
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
      expect.anything(),
    );
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

    const bridgeParams = createRealtimeVoiceBridgeSessionMock.mock.calls.at(-1)?.[0] as
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

    expect(agentCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
      expect.anything(),
    );
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
    expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
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

      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ end: { behavior: "Manual" } }),
      );
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

  it("passes senderIsOwner=true for allowlisted voice speakers", async () => {
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

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(true);
  });

  it("passes senderIsOwner=false for non-owner voice speakers", async () => {
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

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(commandArgs?.senderIsOwner).toBe(false);
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

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
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

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { message?: string; messageChannel?: string; messageProvider?: string }
      | undefined;

    expect(commandArgs?.messageChannel).toBe("discord");
    expect(commandArgs?.messageProvider).toBe("discord-voice");
    expect(commandArgs?.message).toContain("Do not call the tts tool");
    expect(commandArgs?.message).toContain("repair obvious transcription artifacts");
    expect(textToSpeechMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        text: "hello back",
      }),
    );
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

    expect(textToSpeechStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        disableFallback: true,
        text: "hello back",
      }),
    );
    expect(textToSpeechMock).not.toHaveBeenCalled();
    expect(createAudioResourceMock).toHaveBeenCalledWith(expect.anything());
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("passes per-channel system prompt overrides to voice agent runs", async () => {
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

    const commandArgs = agentCommandMock.mock.calls.at(-1)?.[0] as
      | { extraSystemPrompt?: string }
      | undefined;

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

    expect(cached).toEqual(
      expect.objectContaining({
        id: "u-role",
        label: "Role Speaker",
      }),
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
