import type { RealtimeVoiceAgentControlResult } from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";
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
  loggerWarnMock,
  loggerErrorMock,
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  controlRealtimeVoiceAgentRunMock,
  createRealtimeSessionMock,
  realtimeSessionMock,
  decodeOpusStreamMock,
  decodeOpusStreamChunksMock,
  updateVoiceStateMock,
  enqueueSystemEventMock,
  assertSecretOwnerAvailableMock,
  isSecretOwnerAvailableMock,
  canonicalizeRealtimeVoiceProviderIdMock,
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
            lastTransitionId?: number;
            reinitializing?: boolean;
            recoverFromInvalidTransition?: ReturnType<typeof vi.fn>;
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

  const createConnectionMockLocal = (): MockConnection => {
    const handlers = new Map<string, EventHandler>();
    const daveSetPassthroughMode = vi.fn() as Mock;
    const connection: MockConnection = {
      destroy: vi.fn() as Mock,
      subscribe: vi.fn() as Mock,
      on: vi.fn((event: string, handler: EventHandler) => {
        handlers.set(event, handler);
      }),
      off: vi.fn() as Mock,
      receiver: {
        speaking: {
          on: vi.fn() as Mock,
          off: vi.fn() as Mock,
        },
        subscribe: vi.fn(() => ({
          on: vi.fn() as Mock,
          off: vi.fn() as Mock,
          destroy: vi.fn() as Mock,
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

  const getVoiceConnectionMockLocal = vi.fn((): MockConnection | undefined => undefined);

  const createRealtimeSessionMockLocal = () => ({
    bridge: {
      supportsToolResultContinuation: true,
      supportsToolResultSuppression: true as boolean | undefined,
      handleBargeIn: vi.fn() as Mock | undefined,
    },
    acknowledgeMark: vi.fn() as Mock,
    close: vi.fn() as Mock,
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn() as Mock,
    sendUserMessage: vi.fn() as Mock,
    handleBargeIn: vi.fn() as Mock,
    setMediaTimestamp: vi.fn() as Mock,
    submitToolResult: vi.fn() as Mock,
    triggerGreeting: vi.fn() as Mock,
  });
  const realtimeSessionMockLocal = createRealtimeSessionMockLocal();

  return {
    createConnectionMock: createConnectionMockLocal,
    getVoiceConnectionMock: getVoiceConnectionMockLocal,
    joinVoiceChannelMock: vi.fn(() => createConnectionMockLocal()),
    entersStateMock: vi.fn(
      async (_target?: unknown, _state?: string, _timeoutOrSignal?: number | AbortSignal) => {
        return undefined;
      },
    ),
    createAudioResourceMock: vi.fn(() => ({
      playbackDuration: 0,
      read: vi.fn(() => null),
    })) as Mock,
    createAudioPlayerMock: vi.fn(() => ({
      on: vi.fn() as Mock,
      off: vi.fn() as Mock,
      stop: vi.fn() as Mock,
      play: vi.fn() as Mock,
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
    resolveVoiceIngressWithParticipantsMock: vi.fn() as Mock,
    transcribeAudioFileMock: vi.fn(async () => ({ text: "hello from voice" })),
    prepareTtsRequestMock: vi.fn(async ({ cfg, text }: { cfg: unknown; text: string }) => ({
      cfg,
      directives: {
        cleanedText: text,
        hasDirective: false,
        overrides: {},
        warnings: [],
      },
    })),
    textToSpeechStreamMock: vi.fn(async (): Promise<unknown> => ({
      success: false,
      error: "stream unavailable",
    })),
    textToSpeechMock: vi.fn(async () => ({ success: true, audioPath: "/tmp/voice.mp3" })),
    logVerboseMock: vi.fn() as Mock,
    loggerWarnMock: vi.fn() as Mock,
    loggerErrorMock: vi.fn() as Mock,
    resolveConfiguredRealtimeVoiceProviderMock: vi.fn<
      (params?: {
        configuredProviderId?: string;
        isProviderAvailable?: (provider: { id: string }) => boolean;
        assertProviderAvailable?: (provider: { id: string }) => void;
      }) => {
        provider: {
          id: string;
          capabilities?: { supportsActivationNameGating?: boolean };
        };
        providerConfig: Record<string, unknown>;
      }
    >(() => ({
      provider: { id: "openai", capabilities: { supportsActivationNameGating: true } },
      providerConfig: { model: "gpt-realtime-2", voice: "cedar" },
    })),
    createRealtimeVoiceBridgeSessionMock: vi.fn((_params?: unknown) => realtimeSessionMockLocal),
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
    createRealtimeSessionMock: createRealtimeSessionMockLocal,
    realtimeSessionMock: realtimeSessionMockLocal,
    decodeOpusStreamMock: vi.fn() as Mock,
    decodeOpusStreamChunksMock: vi.fn() as Mock,
    updateVoiceStateMock: vi.fn() as Mock,
    enqueueSystemEventMock: vi.fn() as Mock,
    assertSecretOwnerAvailableMock: vi.fn() as Mock,
    isSecretOwnerAvailableMock: vi.fn((_ownerKind: string, _ownerId: string) => true),
    canonicalizeRealtimeVoiceProviderIdMock: vi.fn((providerId: string | undefined) =>
      providerId?.trim().toLowerCase(),
    ),
  };
});

export const voiceTestMocks = {
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
  loggerWarnMock,
  loggerErrorMock,
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  controlRealtimeVoiceAgentRunMock,
  createRealtimeSessionMock,
  realtimeSessionMock,
  decodeOpusStreamMock,
  decodeOpusStreamChunksMock,
  updateVoiceStateMock,
  enqueueSystemEventMock,
  assertSecretOwnerAvailableMock,
  isSecretOwnerAvailableMock,
  canonicalizeRealtimeVoiceProviderIdMock,
};

vi.mock("openclaw/plugin-sdk/channel-secret-owner-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-secret-owner-runtime")
  >("openclaw/plugin-sdk/channel-secret-owner-runtime");
  return {
    ...actual,
    assertSecretOwnerAvailable: assertSecretOwnerAvailableMock,
    isSecretOwnerAvailable: isSecretOwnerAvailableMock,
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
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
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
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: loggerWarnMock,
      error: loggerErrorMock,
    }),
    logVerbose: logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/realtime-voice")>(
    "openclaw/plugin-sdk/realtime-voice",
  );
  return {
    ...actual,
    canonicalizeRealtimeVoiceProviderId: canonicalizeRealtimeVoiceProviderIdMock,
    createRealtimeVoiceBridgeSession: createRealtimeVoiceBridgeSessionMock,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
      let providerSession: typeof realtimeSessionMock | undefined;
      return {
        ...harness,
        createBridge: (bridgeParams: Parameters<typeof harness.createBridge>[0]) =>
          harness.createBridge({
            ...bridgeParams,
            provider: {
              ...bridgeParams.provider,
              label: bridgeParams.provider.label ?? "Test realtime provider",
              isConfigured: bridgeParams.provider.isConfigured ?? (() => true),
              createBridge: (request) => {
                const session = createRealtimeVoiceBridgeSessionMock({
                  ...bridgeParams,
                  audioSink: {
                    ...bridgeParams.audioSink,
                    sendAudio: request.onAudio,
                    clearAudio: request.onClearAudio,
                  },
                  onEvent: request.onEvent,
                  onClose: request.onClose,
                  onReady: request.onReady,
                  onResponseDone: request.onResponseDone,
                  onToolCall: bridgeParams.onToolCall,
                  onTranscript: request.onTranscript,
                });
                providerSession = session;
                return {
                  supportsToolResultContinuation: session.bridge.supportsToolResultContinuation,
                  supportsToolResultSuppression: session.bridge.supportsToolResultSuppression,
                  acknowledgeMark: session.acknowledgeMark,
                  close: session.close,
                  connect: session.connect,
                  ...(session.bridge.handleBargeIn ? { handleBargeIn: session.handleBargeIn } : {}),
                  isConnected: () => true,
                  sendAudio: session.sendAudio,
                  sendUserMessage: session.sendUserMessage,
                  setMediaTimestamp: session.setMediaTimestamp,
                  submitToolResult: (callId, result, options) =>
                    options === undefined
                      ? session.submitToolResult(callId, result)
                      : session.submitToolResult(callId, result, options),
                  triggerGreeting: session.triggerGreeting,
                };
              },
            },
          }),
        flushOutput: (flush: () => void) => flush(),
        handleBargeIn: (
          options: Parameters<typeof harness.handleBargeIn>[0],
          fallbackFlush: () => void,
        ) => {
          providerSession?.handleBargeIn(options);
          // The mock provider never clears audio, so exercise the harness fallback directly.
          // Discord passes a no-op for normal truncation and a real clear for forced paths.
          fallbackFlush();
        },
      };
    },
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

vi.mock("./participant-context.js", async () => {
  const actual = await vi.importActual<typeof import("./participant-context.js")>(
    "./participant-context.js",
  );
  return {
    ...actual,
    resolveDiscordVoiceIngressContextWithParticipants: (
      ...args: Parameters<typeof actual.resolveDiscordVoiceIngressContextWithParticipants>
    ) =>
      resolveVoiceIngressWithParticipantsMock.getMockImplementation()
        ? resolveVoiceIngressWithParticipantsMock(...args)
        : actual.resolveDiscordVoiceIngressContextWithParticipants(...args),
  };
});

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({
    agent: { runCommandFromIngress: agentCommandMock },
    mediaUnderstanding: {
      resolveAudioInputBudget: async ({
        cfg,
      }: {
        cfg: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
      }) =>
        cfg.tools?.media?.audio?.enabled === false
          ? { enabled: false }
          : { enabled: true, maxBytes: cfg.tools?.media?.audio?.maxBytes ?? 20 * 1024 * 1024 },
      transcribeAudioFile: transcribeAudioFileMock,
    },
    tts: {
      prepareTtsRequest: prepareTtsRequestMock,
      textToSpeechStream: textToSpeechStreamMock,
      textToSpeech: textToSpeechMock,
    },
  }),
}));
