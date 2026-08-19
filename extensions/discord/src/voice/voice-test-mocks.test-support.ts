import type { RealtimeVoiceAgentControlResult } from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
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
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  controlRealtimeVoiceAgentRunMock,
  realtimeSessionMock,
  decodeOpusStreamMock,
  decodeOpusStreamChunksMock,
  updateVoiceStateMock,
  enqueueSystemEventMock,
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

  const getVoiceConnectionMockLocal = vi.fn((): MockConnection | undefined => undefined);

  const realtimeSessionMockLocal = {
    bridge: {
      supportsToolResultContinuation: true,
      supportsToolResultSuppression: true as boolean | undefined,
    },
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
    createConnectionMock: createConnectionMockLocal,
    getVoiceConnectionMock: getVoiceConnectionMockLocal,
    joinVoiceChannelMock: vi.fn(() => createConnectionMockLocal()),
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
    resolveVoiceIngressWithParticipantsMock: vi.fn(),
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
    textToSpeechStreamMock: vi.fn(
      async (): Promise<unknown> => ({ success: false, error: "stream unavailable" }),
    ),
    textToSpeechMock: vi.fn(async () => ({ success: true, audioPath: "/tmp/voice.mp3" })),
    logVerboseMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    resolveConfiguredRealtimeVoiceProviderMock: vi.fn<
      () => {
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
    realtimeSessionMock: realtimeSessionMockLocal,
    decodeOpusStreamMock: vi.fn(),
    decodeOpusStreamChunksMock: vi.fn(),
    updateVoiceStateMock: vi.fn(),
    enqueueSystemEventMock: vi.fn(),
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
  resolveConfiguredRealtimeVoiceProviderMock,
  createRealtimeVoiceBridgeSessionMock,
  controlRealtimeVoiceAgentRunMock,
  realtimeSessionMock,
  decodeOpusStreamMock,
  decodeOpusStreamChunksMock,
  updateVoiceStateMock,
  enqueueSystemEventMock,
};

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
    createRealtimeVoiceBridgeSession: createRealtimeVoiceBridgeSessionMock,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
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
                createRealtimeVoiceBridgeSessionMock({
                  ...bridgeParams,
                  audioSink: {
                    ...bridgeParams.audioSink,
                    sendAudio: request.onAudio,
                    clearAudio: request.onClearAudio,
                  },
                  onEvent: request.onEvent,
                  onReady: request.onReady,
                  onResponseDone: request.onResponseDone,
                  onToolCall: bridgeParams.onToolCall,
                  onTranscript: request.onTranscript,
                });
                return {
                  supportsToolResultContinuation:
                    realtimeSessionMock.bridge.supportsToolResultContinuation,
                  supportsToolResultSuppression:
                    realtimeSessionMock.bridge.supportsToolResultSuppression,
                  acknowledgeMark: realtimeSessionMock.acknowledgeMark,
                  close: realtimeSessionMock.close,
                  connect: realtimeSessionMock.connect,
                  handleBargeIn: realtimeSessionMock.handleBargeIn,
                  isConnected: () => true,
                  sendAudio: realtimeSessionMock.sendAudio,
                  sendUserMessage: realtimeSessionMock.sendUserMessage,
                  setMediaTimestamp: realtimeSessionMock.setMediaTimestamp,
                  submitToolResult: (callId, result, options) =>
                    options === undefined
                      ? realtimeSessionMock.submitToolResult(callId, result)
                      : realtimeSessionMock.submitToolResult(callId, result, options),
                  triggerGreeting: realtimeSessionMock.triggerGreeting,
                };
              },
            },
          }),
        flushOutput: (flush: () => void) => flush(),
        handleBargeIn: (
          options: Parameters<typeof harness.handleBargeIn>[0],
          fallbackFlush: () => void,
        ) => {
          realtimeSessionMock.handleBargeIn(options);
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
    mediaUnderstanding: {
      transcribeAudioFile: transcribeAudioFileMock,
    },
    tts: {
      prepareTtsRequest: prepareTtsRequestMock,
      textToSpeechStream: textToSpeechStreamMock,
      textToSpeech: textToSpeechMock,
    },
  }),
}));
