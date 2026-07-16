/**
 * Tests for talk gateway methods that coordinate speech and audio providers.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { buildTalkRealtimeConfig } from "./talk-shared.js";
import { talkHandlers } from "./talk.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshot: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(() => []),
  getResolvedSpeechProviderConfig: vi.fn(() => ({})),
  resolveTtsConfig: vi.fn(() => ({ timeoutMs: 30_000 })),
  synthesizeSpeech: vi.fn(),
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "gemini-live" ? "google" : providerId?.trim().toLowerCase(),
  ),
  listRealtimeVoiceProviders: vi.fn(() => []),
  canonicalizeRealtimeTranscriptionProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "openai-realtime" ? "openai" : providerId?.trim().toLowerCase(),
  ),
  getRealtimeTranscriptionProvider: vi.fn(),
  listRealtimeTranscriptionProviders: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  createTalkRealtimeRelaySession: vi.fn(),
  sendTalkRealtimeRelayAudio: vi.fn(),
  acknowledgeTalkRealtimeRelayMark: vi.fn(),
  cancelTalkRealtimeRelayTurn: vi.fn(),
  stopTalkRealtimeRelaySession: vi.fn(),
  registerTalkRealtimeRelayAgentRun: vi.fn(),
  submitTalkRealtimeRelayToolResult: vi.fn(),
  createTalkTranscriptionRelaySession: vi.fn(),
  sendTalkTranscriptionRelayAudio: vi.fn(),
  cancelTalkTranscriptionRelayTurn: vi.fn(),
  stopTalkTranscriptionRelaySession: vi.fn(),
  chatSend: vi.fn(),
  controlRealtimeVoiceAgentRun: vi.fn(),
  steerTalkRealtimeRelayAgentRun: vi.fn(),
  resolveSessionKeyFromResolveParams: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

vi.mock("../../tts/tts.js", () => ({
  getResolvedSpeechProviderConfig: mocks.getResolvedSpeechProviderConfig,
  resolveTtsConfig: mocks.resolveTtsConfig,
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../talk/provider-registry.js", () => ({
  canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderId,
  listRealtimeVoiceProviders: mocks.listRealtimeVoiceProviders,
}));

vi.mock("../../realtime-transcription/provider-registry.js", () => ({
  canonicalizeRealtimeTranscriptionProviderId: mocks.canonicalizeRealtimeTranscriptionProviderId,
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

vi.mock("../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));

vi.mock("../../talk/agent-run-control.js", () => ({
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": mocks.chatSend,
  },
}));

vi.mock("../sessions-resolve.js", () => ({
  resolveSessionKeyFromResolveParams: mocks.resolveSessionKeyFromResolveParams,
}));

vi.mock("../talk-realtime-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../talk-realtime-relay.js")>();
  return {
    ...actual,
    acknowledgeTalkRealtimeRelayMark: mocks.acknowledgeTalkRealtimeRelayMark,
    cancelTalkRealtimeRelayTurn: mocks.cancelTalkRealtimeRelayTurn,
    createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
    registerTalkRealtimeRelayAgentRun: mocks.registerTalkRealtimeRelayAgentRun,
    sendTalkRealtimeRelayAudio: mocks.sendTalkRealtimeRelayAudio,
    steerTalkRealtimeRelayAgentRun: mocks.steerTalkRealtimeRelayAgentRun,
    stopTalkRealtimeRelaySession: mocks.stopTalkRealtimeRelaySession,
    submitTalkRealtimeRelayToolResult: mocks.submitTalkRealtimeRelayToolResult,
  };
});

vi.mock("../talk-transcription-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../talk-transcription-relay.js")>();
  return {
    ...actual,
    cancelTalkTranscriptionRelayTurn: mocks.cancelTalkTranscriptionRelayTurn,
    createTalkTranscriptionRelaySession: mocks.createTalkTranscriptionRelaySession,
    sendTalkTranscriptionRelayAudio: mocks.sendTalkTranscriptionRelayAudio,
    stopTalkTranscriptionRelaySession: mocks.stopTalkTranscriptionRelaySession,
  };
});

function createTalkConfig(apiKey: unknown): OpenClawConfig {
  return {
    talk: {
      provider: "acme",
      providers: {
        acme: {
          apiKey,
          voiceId: "stub-default-voice",
        },
      },
    },
  } as OpenClawConfig;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call.at(argIndex);
}

function expectRespondOk(mock: ReturnType<typeof vi.fn>, expected?: Record<string, unknown>) {
  expect(mockCallArg(mock)).toBe(true);
  const result = mockCallArg(mock, 0, 1);
  if (expected) {
    expectRecordFields(result, expected);
  }
  expect(mockCallArg(mock, 0, 2)).toBeUndefined();
  return result;
}

function expectRespondError(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  expect(mockCallArg(mock)).toBe(false);
  expect(mockCallArg(mock, 0, 1)).toBeUndefined();
  return expectRecordFields(mockCallArg(mock, 0, 2), expected);
}

beforeEach(() => {
  mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    const providers = mocks.listRealtimeTranscriptionProviders() as Array<{
      id: string;
      aliases?: string[];
    }>;
    return providers.find(
      (provider) =>
        provider.id.toLowerCase() === normalized ||
        provider.aliases?.some((alias) => alias.toLowerCase() === normalized),
    );
  });
});

describe("talk.catalog handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSpeechProviders.mockReturnValue([]);
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([]);
    mocks.listRealtimeVoiceProviders.mockReturnValue([]);
    mocks.getResolvedSpeechProviderConfig.mockReturnValue({});
    mocks.resolveTtsConfig.mockReturnValue({ timeoutMs: 30_000 });
  });

  it("returns safe speech, transcription, and realtime catalogs without provider secrets", async () => {
    mocks.listSpeechProviders.mockReturnValue([
      {
        id: "elevenlabs",
        label: "ElevenLabs",
        aliases: ["11labs"],
        models: ["eleven_flash_v2_5"],
        voices: ["voice-1"],
        isConfigured: vi.fn(() => true),
      } as never,
    ]);
    mocks.getResolvedSpeechProviderConfig.mockReturnValue({ apiKey: "speech-key" });
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI Realtime Transcription",
        aliases: ["openai-realtime"],
        defaultModel: "gpt-4o-transcribe",
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
      } as never,
      {
        id: "deepgram",
        label: "Deepgram Realtime Transcription",
        aliases: ["deepgram-realtime"],
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "deepgram-key"),
      } as never,
    ]);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "google",
        label: "Google Live Voice",
        defaultModel: "gemini-live",
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(
          ({ providerConfig }) =>
            providerConfig.apiKey === "live-key" &&
            providerConfig.project === "base" &&
            providerConfig.model === "talk-model",
        ),
        capabilities: {
          transports: ["provider-websocket", "gateway-relay"],
          inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
          outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
          supportsBrowserSession: true,
          supportsBargeIn: true,
          supportsToolCalls: true,
          supportsVideoFrames: true,
          supportsSessionResumption: true,
        },
        createBrowserSession: vi.fn(),
        createBridge: vi.fn(),
      } as never,
      {
        id: "openai",
        label: "OpenAI Realtime",
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "openai-key"),
        createBridge: vi.fn(),
      } as never,
    ]);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: { id: "google" },
      providerConfig: { apiKey: "live-key", project: "base", model: "talk-model" },
    } as never);

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              provider: "elevenlabs",
              providers: { elevenlabs: { apiKey: "speech-key" } },
              realtime: {
                provider: "google",
                providers: {
                  google: { apiKey: "live-key", project: "base" },
                },
                model: "talk-model",
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "openai-realtime",
                      providers: { "openai-realtime": { apiKey: "stt-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        modes: ["realtime", "stt-tts", "transcription"],
        transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
        brains: ["agent-consult", "direct-tools", "none"],
        speech: {
          activeProvider: "elevenlabs",
          providers: [
            {
              id: "elevenlabs",
              label: "ElevenLabs",
              aliases: ["11labs"],
              configured: true,
              modes: ["stt-tts"],
              brains: ["agent-consult"],
              models: ["eleven_flash_v2_5"],
              voices: ["voice-1"],
            },
          ],
        },
        transcription: {
          ready: true,
          activeProvider: "openai",
          providers: [
            {
              id: "openai",
              label: "OpenAI Realtime Transcription",
              aliases: ["openai-realtime"],
              configured: true,
              modes: ["transcription"],
              transports: ["gateway-relay"],
              brains: ["none"],
              defaultModel: "gpt-4o-transcribe",
            },
            {
              id: "deepgram",
              label: "Deepgram Realtime Transcription",
              aliases: ["deepgram-realtime"],
              configured: false,
              modes: ["transcription"],
              transports: ["gateway-relay"],
              brains: ["none"],
            },
          ],
        },
        realtime: {
          ready: true,
          activeProvider: "google",
          providers: [
            {
              id: "google",
              label: "Google Live Voice",
              configured: true,
              defaultModel: "gemini-live",
              modes: ["realtime"],
              transports: ["provider-websocket", "gateway-relay"],
              brains: ["agent-consult"],
              inputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
              outputAudioFormats: [{ encoding: "pcm16", sampleRateHz: 24000, channels: 1 }],
              supportsBrowserSession: true,
              supportsBargeIn: true,
              supportsToolCalls: true,
              supportsVideoFrames: true,
              supportsSessionResumption: true,
            },
            {
              id: "openai",
              label: "OpenAI Realtime",
              configured: false,
              modes: ["realtime"],
              brains: ["agent-consult"],
              supportsBrowserSession: false,
            },
          ],
        },
      },
      undefined,
    );
    const responsePayload = JSON.stringify(mockCallArg(respond, 0, 1));
    expect(responsePayload).not.toContain("speech-key");
    expect(responsePayload).not.toContain("stt-key");
    expect(responsePayload).not.toContain("live-key");
  });

  it("reports the runtime-selected automatic providers instead of registry row order", async () => {
    const transcriptionSlow = {
      id: "transcription-slow",
      label: "Transcription Slow",
      autoSelectOrder: 20,
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
    };
    const transcriptionFast = {
      id: "transcription-fast",
      label: "Transcription Fast",
      models: ["transcribe-model"],
      autoSelectOrder: 10,
      isConfigured: vi.fn(
        ({ providerConfig }) =>
          providerConfig.enabled === true && providerConfig.model === "transcribe-model",
      ),
    };
    const realtimeSlow = {
      id: "realtime-slow",
      label: "Realtime Slow",
      autoSelectOrder: 20,
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
      createBridge: vi.fn(),
    };
    const realtimeFast = {
      id: "realtime-fast",
      label: "Realtime Fast",
      autoSelectOrder: 10,
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.enabled === true),
      createBridge: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      transcriptionSlow,
      transcriptionFast,
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeSlow, realtimeFast] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: realtimeFast,
      providerConfig: { enabled: true },
    } as never);

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: { primary: "transcription-fast/transcribe-model" },
              },
            },
            talk: {
              realtime: {
                providers: {
                  "realtime-slow": { enabled: true },
                  "realtime-fast": { enabled: true },
                },
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      providers: {
                        "transcription-slow": { enabled: true },
                        "transcription-fast": { enabled: true },
                      },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: {
        ready: true,
        activeProvider: "transcription-fast",
        providers: [
          { id: "transcription-slow", configured: true },
          { id: "transcription-fast", configured: true },
        ],
      },
      realtime: { ready: true, activeProvider: "realtime-fast" },
    });
  });

  it("includes a provider-map transcription provider missing from the active registry", async () => {
    const openai = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
      isConfigured: vi.fn(() => false),
    };
    const xai = {
      id: "xai",
      label: "xAI Realtime Transcription",
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "xai-key"),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([openai] as never);
    mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) =>
      providerId === "xai" ? (xai as never) : undefined,
    );

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      providers: { xai: { apiKey: "xai-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: {
        ready: true,
        activeProvider: "xai",
        providers: [
          { id: "openai", configured: false },
          { id: "xai", configured: true },
        ],
      },
    });
  });

  it("reports the provider selected by runtime resolution when aliases collide", async () => {
    const transcriptionAlias = {
      id: "transcription-alias",
      label: "Transcription Alias",
      aliases: ["shared-transcription"],
      isConfigured: vi.fn(() => true),
    };
    const transcriptionDirect = {
      id: "shared-transcription",
      label: "Transcription Direct",
      isConfigured: vi.fn(() => true),
    };
    const realtimeAlias = {
      id: "realtime-alias",
      label: "Realtime Alias",
      aliases: ["shared-realtime"],
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    const realtimeDirect = {
      id: "shared-realtime",
      label: "Realtime Direct",
      isConfigured: vi.fn(() => true),
      createBridge: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      transcriptionAlias,
      transcriptionDirect,
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([realtimeAlias, realtimeDirect] as never);
    mocks.canonicalizeRealtimeTranscriptionProviderId.mockReturnValueOnce("shared-transcription");
    mocks.canonicalizeRealtimeVoiceProviderId.mockReturnValueOnce("shared-realtime");
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: realtimeAlias,
      providerConfig: { enabled: true },
    } as never);

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              realtime: {
                provider: "shared-realtime",
                providers: { "shared-realtime": { enabled: true } },
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "shared-transcription",
                      providers: { "shared-transcription": { enabled: true } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: { ready: true, activeProvider: "transcription-alias" },
      realtime: { ready: true, activeProvider: "realtime-alias" },
    });
  });

  it("reports an authoritative setup requirement when automatic selection fails", async () => {
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      {
        id: "transcription",
        label: "Transcription",
        isConfigured: vi.fn(() => false),
      },
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "realtime",
        label: "Realtime",
        isConfigured: vi.fn(() => false),
        createBridge: vi.fn(),
      },
    ] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockImplementation(() => {
      throw new Error("No realtime voice provider configured");
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig } as never,
    });

    const catalog = mockCallArg(respond, 0, 1) as Record<string, Record<string, unknown>>;
    expect(catalog.transcription).toMatchObject({ ready: false });
    expect(catalog.transcription).not.toHaveProperty("activeProvider");
    expect(catalog.realtime).toMatchObject({ ready: false });
    expect(catalog.realtime).not.toHaveProperty("activeProvider");
  });

  it("validates explicitly selected providers before reporting readiness", async () => {
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      {
        id: "transcription",
        label: "Transcription",
        isConfigured: vi.fn(() => false),
      },
    ] as never);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "realtime",
        label: "Realtime",
        isConfigured: vi.fn(() => false),
        createBridge: vi.fn(),
      },
    ] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockImplementation(() => {
      throw new Error("Realtime provider is not configured");
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.catalog"],
      'talkHandlers["talk.catalog"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.catalog" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: { realtime: { provider: "realtime" } },
            plugins: {
              entries: {
                "voice-call": { config: { streaming: { provider: "transcription" } } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mockCallArg(respond, 0, 1)).toMatchObject({
      transcription: { ready: false, activeProvider: "transcription" },
      realtime: { ready: false, activeProvider: "realtime" },
    });
  });
});

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active runtime config snapshot instead of the raw config snapshot", async () => {
    const runtimeConfig = createTalkConfig("env-acme-key");
    runtimeConfig.talk = {
      provider: "acme",
      providers: {
        acme: {
          apiKey: "env-acme-key",
          speakerVoice: "talk-speaker",
          speakerVoiceId: "talk-speaker-id",
          voice: "explicit-talk-voice",
          voiceId: "explicit-talk-voice-id",
        },
      },
    };
    runtimeConfig.messages = {
      tts: {
        providers: {
          acme: {
            speakerVoice: "marin",
            speakerVoiceId: "voice-123",
          },
        },
      },
    };
    const diskConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });

    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: diskConfig,
    });
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Speech",
      resolveTalkConfig: ({
        baseTtsConfig,
        talkProviderConfig,
      }: {
        baseTtsConfig: Record<string, unknown>;
        talkProviderConfig: Record<string, unknown>;
      }) => {
        expectRecordFields(talkProviderConfig, {
          speakerVoice: "talk-speaker",
          voice: "explicit-talk-voice",
          voiceName: "talk-speaker",
          speakerVoiceId: "talk-speaker-id",
          voiceId: "explicit-talk-voice-id",
        });
        expectRecordFields(expectRecordFields(baseTtsConfig.providers, {}).acme, {
          speakerVoice: "marin",
          voice: "marin",
          voiceName: "marin",
          speakerVoiceId: "voice-123",
          voiceId: "voice-123",
        });
        return talkProviderConfig;
      },
    });
    mocks.synthesizeSpeech.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig; text: string; disableFallback: boolean }) => {
        expect(cfg.messages?.tts?.provider).toBe("acme");
        expect(cfg.messages?.tts?.providers?.acme?.apiKey).toBe("env-acme-key");
        return {
          success: true,
          provider: "acme",
          audioBuffer: Buffer.from([1, 2, 3]),
          outputFormat: "mp3",
          voiceCompatible: false,
          fileExtension: ".mp3",
        };
      },
    );

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.speak"],
      'talkHandlers["talk.speak"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.speak" },
      params: { text: "Hello from talk mode." },
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.synthesizeSpeech), {
      text: "Hello from talk mode.",
      disableFallback: true,
    });
    expectRespondOk(respond, {
      provider: "acme",
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      outputFormat: "mp3",
      mimeType: "audio/mpeg",
      fileExtension: ".mp3",
    });
  });
});

describe("talk.config handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects the runtime realtime transport when source config is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: false,
      config: {},
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              realtime: { transport: "provider-websocket" },
            },
          }) as OpenClawConfig,
      } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    expectRecordFields(response.config?.talk?.realtime, {
      transport: "provider-websocket",
    });
  });

  it("projects effective legacy realtime provider config for native routing", async () => {
    const resolveConfig = vi.fn(
      ({ rawConfig }: { rawConfig: Record<string, unknown> }): Record<string, unknown> => ({
        ...rawConfig,
        apiKey: normalizeResolvedSecretInputString({
          value: rawConfig.apiKey,
          path: "plugins.entries.voice-call.config.realtime.providers.openai.apiKey",
        }),
      }),
    );
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI Realtime",
        models: ["gpt-realtime"],
        resolveConfig,
        isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
          providerConfig.apiKey === "runtime-azure-secret",
      },
    ] as never);
    const sourceConfig = {
      agents: {
        defaults: {
          voiceModel: { primary: "openai/gpt-realtime" },
        },
      },
      talk: {
        realtime: {
          speakerVoice: "marin",
          speakerVoiceId: "voice-id",
        },
      },
      plugins: {
        entries: {
          "voice-call": {
            config: {
              realtime: {
                providers: {
                  " OpenAI ": {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "AZURE_OPENAI_API_KEY",
                    },
                    azureEndpoint: "https://example.openai.azure.com",
                    azureDeployment: "realtime-prod",
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      plugins: {
        entries: {
          "voice-call": {
            config: {
              realtime: {
                providers: {
                  " OpenAI ": {
                    apiKey: "runtime-azure-secret",
                    azureEndpoint: "https://example.openai.azure.com",
                    azureDeployment: "realtime-prod",
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const realtime = expectRecordFields(response.config?.talk?.realtime, {
      provider: "openai",
      model: "gpt-realtime",
      speakerVoice: "marin",
      speakerVoiceId: "voice-id",
    });
    const providers = realtime.providers as Record<string, unknown> | undefined;
    expectRecordFields(providers?.openai, {
      apiKey: {
        source: "__OPENCLAW_REDACTED__",
        provider: "__OPENCLAW_REDACTED__",
        id: "__OPENCLAW_REDACTED__",
      },
      azureEndpoint: "https://example.openai.azure.com",
      azureDeployment: "realtime-prod",
    });
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockCallArg(resolveConfig))).toContain("runtime-azure-secret");
    expect(JSON.stringify(response)).not.toContain("runtime-azure-secret");
  });

  it("passes runtime-resolved messages.tts provider secrets to strict provider resolvers", async () => {
    const sourceConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            speakerVoice: "talk-speaker",
            speakerVoiceId: "talk-speaker-id",
            voice: "explicit-talk-voice",
            voiceId: "explicit-talk-voice-id",
          },
        },
      },
      messages: {
        tts: {
          provider: "acme",
          timeoutMs: 12_345,
          providers: {
            acme: {
              apiKey: { source: "env", provider: "default", id: "ACME_SPEECH_API_KEY" },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      messages: {
        tts: {
          provider: "acme",
          timeoutMs: 54_321,
          providers: {
            acme: {
              apiKey: "env-acme-key",
            },
          },
        },
      },
    } as OpenClawConfig;

    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });
    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Strict Speech",
      resolveTalkConfig: ({
        baseTtsConfig,
        talkProviderConfig,
        timeoutMs,
      }: {
        baseTtsConfig: Record<string, unknown>;
        talkProviderConfig: Record<string, unknown>;
        timeoutMs: number;
      }) => {
        const providers = (baseTtsConfig.providers ?? {}) as Record<string, unknown>;
        const providerConfig = (providers.acme ?? {}) as Record<string, unknown>;
        const apiKey = normalizeResolvedSecretInputString({
          value: providerConfig.apiKey,
          path: "messages.tts.providers.acme.apiKey",
        });
        expect(apiKey).toBe("env-acme-key");
        expect(timeoutMs).toBe(54_321);
        expectRecordFields(talkProviderConfig, {
          speakerVoice: "talk-speaker",
          voice: "explicit-talk-voice",
          voiceName: "talk-speaker",
          speakerVoiceId: "talk-speaker-id",
          voiceId: "explicit-talk-voice-id",
        });
        return {
          ...talkProviderConfig,
          ...(apiKey === undefined ? {} : { apiKey }),
        };
      },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const talkConfig = response.config?.talk;
    expectRecordFields(talkConfig, { provider: "acme" });
    const resolved = talkConfig?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved, { provider: "acme" });
    expectRecordFields(resolved?.config, { apiKey: "__OPENCLAW_REDACTED__" });
  });

  it("returns runtime-resolved Talk provider SecretRefs to authorized clients", async () => {
    const sourceConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });
    const runtimeConfig = createTalkConfig("runtime-resolved-talk-key");

    mocks.getSpeechProvider.mockReturnValue(undefined);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: { includeSecrets: true },
      client: { connect: { scopes: ["operator.talk.secrets"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const talkConfig = response.config?.talk;
    expectRecordFields(talkConfig, { provider: "acme" });
    const providers = talkConfig?.providers as Record<string, unknown> | undefined;
    const providerConfig = expectRecordFields(providers?.acme, { voiceId: "stub-default-voice" });
    expectRecordFields(providerConfig.apiKey, {
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });
    const resolved = talkConfig?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved, { provider: "acme" });
    expectRecordFields(resolved?.config, { apiKey: "runtime-resolved-talk-key" });
  });

  it("materializes only the active Talk provider apiKey for authorized clients", async () => {
    const sourceConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            apiKey: { source: "env", provider: "default", id: "ACME_SPEECH_API_KEY" },
            voiceId: "active-voice",
          },
          other: {
            apiKey: { source: "env", provider: "default", id: "OTHER_SPEECH_API_KEY" },
            voiceId: "inactive-voice",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_REALTIME_API_KEY" },
              voice: "cedar",
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            apiKey: "runtime-active-talk-key",
            voiceId: "active-voice",
          },
          other: {
            apiKey: "runtime-inactive-talk-key",
            voiceId: "inactive-voice",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "runtime-realtime-key",
              voice: "cedar",
            },
          },
        },
      },
    } as OpenClawConfig;

    mocks.getSpeechProvider.mockReturnValue(undefined);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: { includeSecrets: true },
      client: { connect: { scopes: ["operator.talk.secrets"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const talkConfig = response.config?.talk;
    const providers = talkConfig?.providers as Record<string, unknown> | undefined;
    expectRecordFields((providers?.acme as Record<string, unknown> | undefined)?.apiKey, {
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });
    expectRecordFields((providers?.other as Record<string, unknown> | undefined)?.apiKey, {
      source: "env",
      provider: "default",
      id: "OTHER_SPEECH_API_KEY",
    });
    const realtime = talkConfig?.realtime as Record<string, unknown> | undefined;
    const realtimeProviders = realtime?.providers as Record<string, unknown> | undefined;
    expectRecordFields((realtimeProviders?.openai as Record<string, unknown> | undefined)?.apiKey, {
      source: "env",
      provider: "default",
      id: "OPENAI_REALTIME_API_KEY",
    });
    const resolved = talkConfig?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved, { provider: "acme" });
    expectRecordFields(resolved?.config, { apiKey: "runtime-active-talk-key" });

    const serialized = JSON.stringify(response);
    expect(serialized).toContain("runtime-active-talk-key");
    expect(serialized).not.toContain("runtime-inactive-talk-key");
    expect(serialized).not.toContain("runtime-realtime-key");
  });

  it("does not expose resolver-returned secret-like fields beyond apiKey", async () => {
    const sourceConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });
    const runtimeConfig = createTalkConfig("runtime-resolved-talk-key");

    mocks.getSpeechProvider.mockReturnValue({
      id: "acme",
      label: "Acme Speech",
      resolveTalkConfig: ({
        talkProviderConfig,
      }: {
        talkProviderConfig: Record<string, unknown>;
      }) => ({
        ...talkProviderConfig,
        voiceId: "resolver-voice",
        clientSecret: "resolver-client-secret",
        authToken: "resolver-auth-token",
      }),
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: { includeSecrets: true },
      client: { connect: { scopes: ["operator.talk.secrets"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const resolved = response.config?.talk?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved?.config, {
      apiKey: "runtime-resolved-talk-key",
      voiceId: "resolver-voice",
      clientSecret: "__OPENCLAW_REDACTED__",
      authToken: "__OPENCLAW_REDACTED__",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("resolver-client-secret");
    expect(serialized).not.toContain("resolver-auth-token");
  });

  it("does not expose source provider raw keys or secret-like sibling fields", async () => {
    const sourceConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            apiKey: "source-active-talk-key",
            voiceId: "active-voice",
            clientSecret: "source-client-secret",
          },
          other: {
            apiKey: "source-inactive-talk-key",
            voiceId: "inactive-voice",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "source-realtime-key",
              authToken: "source-realtime-auth-token",
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            apiKey: "runtime-active-talk-key",
            voiceId: "active-voice",
            clientSecret: "runtime-client-secret",
          },
          other: {
            apiKey: "runtime-inactive-talk-key",
            voiceId: "inactive-voice",
          },
        },
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "runtime-realtime-key",
              authToken: "runtime-realtime-auth-token",
            },
          },
        },
      },
    } as OpenClawConfig;

    mocks.getSpeechProvider.mockReturnValue(undefined);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: { includeSecrets: true },
      client: { connect: { scopes: ["operator.talk.secrets"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const resolved = response.config?.talk?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved?.config, {
      apiKey: "runtime-active-talk-key",
      clientSecret: "__OPENCLAW_REDACTED__",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).toContain("runtime-active-talk-key");
    expect(serialized).not.toContain("source-active-talk-key");
    expect(serialized).not.toContain("source-inactive-talk-key");
    expect(serialized).not.toContain("source-realtime-key");
    expect(serialized).not.toContain("source-client-secret");
    expect(serialized).not.toContain("source-realtime-auth-token");
    expect(serialized).not.toContain("runtime-inactive-talk-key");
    expect(serialized).not.toContain("runtime-realtime-key");
    expect(serialized).not.toContain("runtime-client-secret");
    expect(serialized).not.toContain("runtime-realtime-auth-token");
  });

  it("redacts runtime-resolved Talk provider SecretRefs without Talk secret scope", async () => {
    const sourceConfig = createTalkConfig({
      source: "env",
      provider: "default",
      id: "ACME_SPEECH_API_KEY",
    });
    const runtimeConfig = createTalkConfig("runtime-resolved-talk-key");

    mocks.getSpeechProvider.mockReturnValue(undefined);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      hash: "test-hash",
      valid: true,
      config: sourceConfig,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.config"],
      'talkHandlers["talk.config"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.config" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    const response = expectRespondOk(respond) as { config?: { talk?: Record<string, unknown> } };
    const resolved = response.config?.talk?.resolved as Record<string, unknown> | undefined;
    expectRecordFields(resolved, { provider: "acme" });
    const resolvedConfig = expectRecordFields(resolved?.config, {});
    expectRecordFields(resolvedConfig.apiKey, {
      source: "__OPENCLAW_REDACTED__",
      provider: "__OPENCLAW_REDACTED__",
      id: "__OPENCLAW_REDACTED__",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("runtime-resolved-talk-key");
    expect(serialized).not.toContain("ACME_SPEECH_API_KEY");
  });
});

describe("talk.session unified handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSessionKeyFromResolveParams.mockImplementation(async ({ p }) => {
      const key = (p as { key?: unknown }).key;
      return {
        ok: true,
        key: typeof key === "string" ? key : "session:main",
      };
    });
    mocks.steerTalkRealtimeRelayAgentRun.mockResolvedValue({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      sessionId: "session-active",
      active: true,
      queued: true,
      message: "Steered the active OpenClaw run.",
      speak: false,
      show: true,
      suppress: true,
    });
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
      ok: true,
      mode: "steer",
      sessionKey: "session:main",
      sessionId: "session-active",
      active: true,
      queued: true,
      message: "Steered the active OpenClaw run.",
      speak: false,
      show: true,
      suppress: true,
    });
  });

  it("creates and drives a realtime gateway-relay session through the unified API", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-default",
      models: ["gpt-realtime-default", "gpt-realtime"],
      isConfigured: () => true,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key" },
    });
    mocks.createTalkRealtimeRelaySession.mockReturnValue({
      provider: "openai",
      transport: "gateway-relay",
      relaySessionId: "relay-unified-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
      model: "gpt-realtime",
      voice: "alloy",
      expiresAt: 1_797_986_400,
    });

    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        model: "gpt-realtime",
        voice: "alloy",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: { primary: "openai/gpt-realtime-default" },
              },
            },
            talk: {
              realtime: {
                provider: "openai",
                providers: { openai: { apiKey: "openai-key" } },
                instructions: "Speak warmly.",
                consultRouting: "force-agent-consult",
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: "gpt-realtime-default",
    });
    const relayCreateInput = mockCallArg(mocks.createTalkRealtimeRelaySession) as Record<
      string,
      unknown
    >;
    expectRecordFields(relayCreateInput, { connId: "conn-1", provider });
    expectRecordFields(relayCreateInput.providerConfig, {
      apiKey: "openai-key",
      model: "gpt-realtime",
      voice: "alloy",
    });
    expect(relayCreateInput.instructions).toContain(
      "Additional realtime instructions:\nSpeak warmly.",
    );
    expect(relayCreateInput.forceAgentConsultOnFinalTranscript).toBe(true);
    expect(relayCreateInput.instructions).toContain("tool-backed actions");
    expect(relayCreateInput.instructions).toContain("Let me check that for you");
    expectRespondOk(createRespond, {
      sessionId: "relay-unified-1",
      relaySessionId: "relay-unified-1",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    });

    const inputRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.appendAudio"],
      'talkHandlers["talk.session.appendAudio"] test invariant',
    )({
      req: { type: "req", id: "2", method: "talk.session.appendAudio" },
      params: { sessionId: "relay-unified-1", audioBase64: "aGVsbG8=", timestamp: 42 },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: inputRespond as never,
      context: {} as never,
    });
    expect(mocks.sendTalkRealtimeRelayAudio).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      audioBase64: "aGVsbG8=",
      timestamp: 42,
    });

    const cancelRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.cancelOutput"],
      'talkHandlers["talk.session.cancelOutput"] test invariant',
    )({
      req: { type: "req", id: "3", method: "talk.session.cancelOutput" },
      params: { sessionId: "relay-unified-1", reason: "barge-in" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: cancelRespond as never,
      context: {} as never,
    });
    expect(mocks.cancelTalkRealtimeRelayTurn).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      reason: "barge-in",
    });

    const markRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.acknowledgeMark"],
      'talkHandlers["talk.session.acknowledgeMark"] test invariant',
    )({
      req: { type: "req", id: "3-mark", method: "talk.session.acknowledgeMark" },
      params: { sessionId: "relay-unified-1", markName: "audio-mark-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: markRespond as never,
      context: {} as never,
    });
    expect(mocks.acknowledgeTalkRealtimeRelayMark).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      markName: "audio-mark-1",
    });
    expectRespondOk(markRespond, { ok: true });

    let acceptToolResult!: () => void;
    mocks.submitTalkRealtimeRelayToolResult.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        acceptToolResult = resolve;
      }),
    );
    const toolRespond = vi.fn();
    const toolRequest = expectDefined(
      talkHandlers["talk.session.submitToolResult"],
      'talkHandlers["talk.session.submitToolResult"] test invariant',
    )({
      req: { type: "req", id: "4", method: "talk.session.submitToolResult" },
      params: {
        sessionId: "relay-unified-1",
        callId: "call-1",
        result: { status: "working" },
        options: { suppressResponse: true, willContinue: true },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: toolRespond as never,
      context: {} as never,
    });
    expect(toolRespond).not.toHaveBeenCalled();
    acceptToolResult();
    await toolRequest;
    expect(mocks.submitTalkRealtimeRelayToolResult).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      callId: "call-1",
      result: { status: "working" },
      options: { suppressResponse: true, willContinue: true },
    });
    expectRespondOk(toolRespond, { ok: true });

    mocks.submitTalkRealtimeRelayToolResult.mockRejectedValueOnce(
      new Error("provider rejected tool result"),
    );
    const rejectedToolRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.submitToolResult"],
      'talkHandlers["talk.session.submitToolResult"] test invariant',
    )({
      req: { type: "req", id: "4-rejected", method: "talk.session.submitToolResult" },
      params: {
        sessionId: "relay-unified-1",
        callId: "call-rejected",
        result: { ok: true },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: rejectedToolRespond as never,
      context: {} as never,
    });
    expectRespondError(rejectedToolRespond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: provider rejected tool result",
    });

    const steerRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.steer"],
      'talkHandlers["talk.session.steer"] test invariant',
    )({
      req: { type: "req", id: "5", method: "talk.session.steer" },
      params: {
        sessionId: "relay-unified-1",
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: steerRespond as never,
      context: {} as never,
    });
    expect(mocks.steerTalkRealtimeRelayAgentRun).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      sessionKey: "agent:main:main",
      text: "use the safer plan",
      mode: "steer",
    });
    expectRespondOk(steerRespond, {
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
    });

    const closeRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "6", method: "talk.session.close" },
      params: { sessionId: "relay-unified-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: closeRespond as never,
      context: {} as never,
    });
    expect(mocks.stopTalkRealtimeRelaySession).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
    });
    expect(closeRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("returns classified talk issue details when realtime relay creation fails", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: vi.fn(),
    };
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "bad-key" },
    });
    mocks.createTalkRealtimeRelaySession.mockImplementation(() => {
      throw new Error("OpenAI API key rejected with 401");
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
        model: "gpt-realtime-2",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              realtime: {
                provider: "openai",
                providers: { openai: { apiKey: "bad-key" } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    const error = expectRespondError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: OpenAI API key rejected with 401",
    });
    expectRecordFields((error.details as Record<string, unknown>).talkIssue, {
      code: "realtime_unavailable",
      message: "Error: OpenAI API key rejected with 401",
      phase: "request",
    });
  });

  it("creates transcription gateway-relay sessions through the unified API", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
      aliases: ["openai-realtime"],
      defaultModel: "gpt-4o-transcribe",
      models: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
      autoSelectOrder: 1,
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
      createSession: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([provider] as never);
    mocks.createTalkTranscriptionRelaySession.mockReturnValue({
      provider: "openai",
      mode: "transcription",
      transport: "gateway-relay",
      transcriptionSessionId: "stt-unified-1",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      expiresAt: 1_797_986_400,
    });

    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: { mode: "transcription", provider: "openai-realtime" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: { primary: "openai/gpt-4o-mini-transcribe" },
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "openai-realtime",
                      providers: { openai: { apiKey: "stt-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRespondOk(createRespond, {
      sessionId: "stt-unified-1",
      transcriptionSessionId: "stt-unified-1",
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    const createInput = mockCallArg(mocks.createTalkTranscriptionRelaySession) as Record<
      string,
      unknown
    >;
    expectRecordFields(createInput.providerConfig, {
      apiKey: "stt-key",
      model: "gpt-4o-mini-transcribe",
    });
    const inputRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.appendAudio"],
      'talkHandlers["talk.session.appendAudio"] test invariant',
    )({
      req: { type: "req", id: "2", method: "talk.session.appendAudio" },
      params: { sessionId: "stt-unified-1", audioBase64: "aGVsbG8=" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: inputRespond as never,
      context: {} as never,
    });
    expect(mocks.sendTalkTranscriptionRelayAudio).toHaveBeenCalledWith({
      transcriptionSessionId: "stt-unified-1",
      connId: "conn-1",
      audioBase64: "aGVsbG8=",
    });

    const closeRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "3", method: "talk.session.close" },
      params: { sessionId: "stt-unified-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: closeRespond as never,
      context: {} as never,
    });
    expect(mocks.stopTalkTranscriptionRelaySession).toHaveBeenCalledWith({
      transcriptionSessionId: "stt-unified-1",
      connId: "conn-1",
    });
  });

  it("creates transcription sessions with an aliased provider missing from the active registry", async () => {
    const openai = {
      id: "openai",
      aliases: ["openai-realtime"],
      label: "OpenAI Realtime Transcription",
      resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
      isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "openai-key"),
      createSession: vi.fn(),
    };
    mocks.listRealtimeTranscriptionProviders.mockReturnValue([
      { id: "xai", label: "xAI Realtime Transcription", isConfigured: () => true },
    ] as never);
    mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) =>
      providerId === "openai-realtime" ? (openai as never) : undefined,
    );
    mocks.createTalkTranscriptionRelaySession.mockReturnValue({
      provider: "openai",
      mode: "transcription",
      transport: "gateway-relay",
      transcriptionSessionId: "stt-openai-1",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      expiresAt: 1_797_986_400,
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: { mode: "transcription", transport: "gateway-relay", brain: "none" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "openai-realtime",
                      providers: { openai: { apiKey: "openai-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRespondOk(respond, {
      provider: "openai",
      transcriptionSessionId: "stt-openai-1",
    });
    expect(mockCallArg(mocks.createTalkTranscriptionRelaySession)).toMatchObject({
      provider: openai,
      providerConfig: { apiKey: "openai-key" },
    });
  });

  it("creates and controls managed-room sessions through the unified API", async () => {
    const broadcastToConnIds = vi.fn();
    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "session:main",
        ttlMs: 5000,
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.admin"] } } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });
    const session = mockCallArg(createRespond, 0, 1) as { sessionId: string; token: string };

    const createResult = expectRespondOk(createRespond, {
      transport: "managed-room",
      brain: "agent-consult",
    }) as Record<string, unknown>;
    expect(createResult.sessionId).toBeTypeOf("string");
    expect(createResult.handoffId).toBeTypeOf("string");
    expect(createResult.roomId).toMatch(/^talk_/);
    expect(createResult.token).toBeTypeOf("string");
    expect(mocks.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      cfg: {},
      p: {
        key: "session:main",
        includeGlobal: true,
        includeUnknown: true,
      },
    });

    const joinRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.join"],
      'talkHandlers["talk.session.join"] test invariant',
    )({
      req: { type: "req", id: "2", method: "talk.session.join" },
      params: { sessionId: session.sessionId, token: session.token },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: joinRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    const joinResult = expectRespondOk(joinRespond, { id: session.sessionId }) as {
      room?: Record<string, unknown>;
    };
    expectRecordFields(joinResult.room, { activeClientId: "conn-1" });
    expect(mockCallArg(broadcastToConnIds)).toBe("talk.event");
    const readyEventPayload = expectRecordFields(mockCallArg(broadcastToConnIds, 0, 1), {
      handoffId: session.sessionId,
    });
    expectRecordFields(readyEventPayload.talkEvent, { type: "session.ready" });
    expect(mockCallArg(broadcastToConnIds, 0, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 0, 3)).toEqual({ dropIfSlow: true });

    const startRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.startTurn"],
      'talkHandlers["talk.session.startTurn"] test invariant',
    )({
      req: { type: "req", id: "3", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: startRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        broadcastToConnIds,
      } as never,
    });

    const startResult = expectRespondOk(startRespond, { ok: true, turnId: "turn-1" }) as {
      events?: unknown[];
    };
    expect(startResult.events).toHaveLength(1);
    expectRecordFields(startResult.events?.[0], { type: "turn.started", turnId: "turn-1" });
    expect(mockCallArg(broadcastToConnIds, 1)).toBe("talk.event");
    const startEventPayload = expectRecordFields(mockCallArg(broadcastToConnIds, 1, 1), {
      handoffId: session.sessionId,
    });
    expectRecordFields(startEventPayload.talkEvent, {
      type: "turn.started",
      turnId: "turn-1",
    });
    expect(mockCallArg(broadcastToConnIds, 1, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 1, 3)).toEqual({ dropIfSlow: true });

    const mismatchedSteerRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.steer"],
      'talkHandlers["talk.session.steer"] test invariant',
    )({
      req: { type: "req", id: "4", method: "talk.session.steer" },
      params: {
        sessionId: session.sessionId,
        sessionKey: "session:other",
        text: "use the safer plan",
        mode: "steer",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: mismatchedSteerRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    expectRespondError(mismatchedSteerRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.steer sessionKey does not match the managed-room session",
    });
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();

    const steerRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.steer"],
      'talkHandlers["talk.session.steer"] test invariant',
    )({
      req: { type: "req", id: "5", method: "talk.session.steer" },
      params: {
        sessionId: session.sessionId,
        text: "use the safer plan",
        mode: "steer",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: steerRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledWith({
      sessionKey: "session:main",
      text: "use the safer plan",
      mode: "steer",
      recentEvents: expect.any(Array),
    });
    expectRespondOk(steerRespond, {
      ok: true,
      mode: "steer",
      sessionKey: "session:main",
    });

    const closeRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "6", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: closeRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    expect(closeRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mockCallArg(broadcastToConnIds, 2)).toBe("talk.event");
    const closedEventPayload = expectRecordFields(mockCallArg(broadcastToConnIds, 2, 1), {
      handoffId: session.sessionId,
    });
    expectRecordFields(closedEventPayload.talkEvent, { type: "session.closed", final: true });
    expect(mockCallArg(broadcastToConnIds, 2, 2)).toEqual(new Set(["conn-1"]));
    expect(mockCallArg(broadcastToConnIds, 2, 3)).toEqual({ dropIfSlow: true });
  });

  it("passes managed-room spawnedBy visibility scope to session resolution", async () => {
    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "agent:worker:subagent:child",
        spawnedBy: "agent:main:parent",
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.write"] } } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    expectRespondOk(createRespond, {
      transport: "managed-room",
      brain: "agent-consult",
    });
    expect(mocks.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      cfg: {},
      p: {
        key: "agent:worker:subagent:child",
        spawnedBy: "agent:main:parent",
        includeGlobal: true,
        includeUnknown: true,
      },
    });
  });

  it("rejects unscoped managed-room session keys without admin scope", async () => {
    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "agent:worker:main",
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.write"] } } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    expectRespondError(createRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message:
        "talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: operator.admin",
    });
    expect(mocks.resolveSessionKeyFromResolveParams).not.toHaveBeenCalled();
  });

  it("requires managed-room ownership before turn control", async () => {
    const broadcastToConnIds = vi.fn();
    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "session:main",
      },
      client: { connId: "creator", connect: { scopes: ["operator.admin"] } } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });
    const session = mockCallArg(createRespond, 0, 1) as { sessionId: string; token: string };

    const unjoinedStartRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.startTurn"],
      'talkHandlers["talk.session.startTurn"] test invariant',
    )({
      req: { type: "req", id: "2", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "creator" } as never,
      isWebchatConnect: () => false,
      respond: unjoinedStartRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expectRespondError(unjoinedStartRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.startTurn requires the active managed-room connection",
    });

    await expectDefined(
      talkHandlers["talk.session.join"],
      'talkHandlers["talk.session.join"] test invariant',
    )({
      req: { type: "req", id: "3", method: "talk.session.join" },
      params: { sessionId: session.sessionId, token: session.token },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: { broadcastToConnIds } as never,
    });

    const staleStartRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.startTurn"],
      'talkHandlers["talk.session.startTurn"] test invariant',
    )({
      req: { type: "req", id: "4", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleStartRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expectRespondError(staleStartRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.startTurn requires the active managed-room connection",
    });

    await expectDefined(
      talkHandlers["talk.session.startTurn"],
      'talkHandlers["talk.session.startTurn"] test invariant',
    )({
      req: { type: "req", id: "5", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: { broadcastToConnIds } as never,
    });

    const staleEndRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.endTurn"],
      'talkHandlers["talk.session.endTurn"] test invariant',
    )({
      req: { type: "req", id: "6", method: "talk.session.endTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleEndRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expectRespondError(staleEndRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.endTurn requires the active managed-room connection",
    });

    const staleCancelRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.cancelTurn"],
      'talkHandlers["talk.session.cancelTurn"] test invariant',
    )({
      req: { type: "req", id: "7", method: "talk.session.cancelTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleCancelRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expectRespondError(staleCancelRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.cancelTurn requires the active managed-room connection",
    });

    const staleCloseRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "8", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleCloseRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expectRespondError(staleCloseRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.session.close requires the active managed-room connection",
    });

    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "9", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: { broadcastToConnIds } as never,
    });
  });

  it("keeps direct-tools managed-room sessions behind admin scope", async () => {
    const rejectedRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        brain: "direct-tools",
        sessionKey: "session:main",
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.write"] } } as never,
      isWebchatConnect: () => false,
      respond: rejectedRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    expectRespondError(rejectedRespond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'talk.session.create brain="direct-tools" requires gateway scope: operator.admin',
    });
    expect(mocks.resolveSessionKeyFromResolveParams).not.toHaveBeenCalled();

    const createRespond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "2", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        brain: "direct-tools",
        sessionKey: "session:main",
      },
      client: { connId: "conn-1", connect: { scopes: ["operator.admin"] } } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    const session = mockCallArg(createRespond, 0, 1) as { sessionId: string };
    const createResult = expectRespondOk(createRespond, {
      transport: "managed-room",
      brain: "direct-tools",
    }) as Record<string, unknown>;
    expect(createResult.sessionId).toBeTypeOf("string");

    await expectDefined(
      talkHandlers["talk.session.close"],
      'talkHandlers["talk.session.close"] test invariant',
    )({
      req: { type: "req", id: "3", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-1", connect: { scopes: ["operator.admin"] } } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: {} as never,
    });
  });

  it("keeps browser-owned transports on the client session endpoint", async () => {
    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.session.create"],
      'talkHandlers["talk.session.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: { mode: "realtime", transport: "webrtc" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig } as never,
    });

    const error = expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
    expect(error.message).toContain("use talk.client.create");
  });
});

describe("talk.client.toolCall handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chatSend.mockImplementation(
      async ({
        respond,
      }: {
        respond: (ok: boolean, result?: unknown, error?: unknown) => void;
      }) => {
        respond(true, { runId: "run-voice-1" }, undefined);
      },
    );
  });

  it("starts agent consult through gateway policy instead of exposing chat.send to browser clients", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.toolCall"],
      'talkHandlers["talk.client.toolCall"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "main",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What is in this repo?", responseStyle: "one sentence" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    const chatInput = mockCallArg(mocks.chatSend) as {
      req?: Record<string, unknown>;
      params?: Record<string, unknown>;
    };
    expectRecordFields(chatInput.req, { method: "chat.send" });
    expectRecordFields(chatInput.params, { sessionKey: "main" });
    expect(chatInput.params?.message).toContain("What is in this repo?");
    expect(chatInput.params?.idempotencyKey).toMatch(/^talk-call-1-/);
    const response = expectRespondOk(respond, { runId: "run-voice-1" }) as Record<string, unknown>;
    expect(response.idempotencyKey).toMatch(/^talk-call-1-/);
  });

  it("returns the tool-call acknowledgement while the agent run continues", async () => {
    let finishRun: (() => void) | undefined;
    mocks.chatSend.mockImplementationOnce(
      ({ respond }: { respond: (ok: boolean, result?: unknown, error?: unknown) => void }) =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
          respond(true, { runId: "run-active" }, undefined);
        }),
    );
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.toolCall"],
      'talkHandlers["talk.client.toolCall"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "main",
        callId: "call-active",
        name: "openclaw_agent_consult",
        args: { question: "What is running?" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        logGateway: { warn: vi.fn() },
      } as never,
    });

    expectRespondOk(respond, { runId: "run-active" });
    finishRun?.();
  });

  it("passes configured consult thinking and fast-mode overrides to chat.send", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.toolCall"],
      'talkHandlers["talk.client.toolCall"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "main",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "Are the basement lights off?" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              consultThinkingLevel: "low",
              consultFastMode: true,
            },
          }) as OpenClawConfig,
      } as never,
    });

    const chatInput = mockCallArg(mocks.chatSend) as { params?: Record<string, unknown> };
    expectRecordFields(chatInput.params, {
      thinking: "low",
      fastMode: true,
    });
    expectRespondOk(respond, { runId: "run-voice-1" });
  });

  it("links relay-owned agent consult runs so relay cancellation can abort them", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.toolCall"],
      'talkHandlers["talk.client.toolCall"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "main",
        relaySessionId: "relay-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What now?" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    expect(mocks.registerTalkRealtimeRelayAgentRun).toHaveBeenCalledWith({
      relaySessionId: "relay-1",
      connId: "conn-1",
      sessionKey: "main",
      runId: "run-voice-1",
      callId: "call-1",
    });
    expectRespondOk(respond, { runId: "run-voice-1" });
  });

  it.each([
    ["timeout", "Realtime agent consult ended before the run started."],
    ["error", "Realtime agent consult failed before the run started."],
    ["ok", "Realtime agent consult completed before the tool result subscription started."],
  ] as const)(
    "rejects terminal agent consult chat.send ACKs with status %s",
    async (status, message) => {
      mocks.chatSend.mockImplementationOnce(
        async ({
          respond,
        }: {
          respond: (ok: boolean, result?: unknown, error?: unknown) => void;
        }) => {
          respond(true, { runId: `run-${status}`, status }, undefined);
        },
      );
      const respond = vi.fn();

      await expectDefined(
        talkHandlers["talk.client.toolCall"],
        'talkHandlers["talk.client.toolCall"] test invariant',
      )({
        req: { type: "req", id: "1", method: "talk.client.toolCall" },
        params: {
          sessionKey: "main",
          relaySessionId: "relay-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "What now?" },
        },
        client: { connId: "conn-1" } as never,
        isWebchatConnect: () => false,
        respond: respond as never,
        context: {
          getRuntimeConfig: () => ({}) as OpenClawConfig,
        } as never,
      });

      expect(mocks.registerTalkRealtimeRelayAgentRun).not.toHaveBeenCalled();
      expectRespondError(respond, {
        code: ErrorCodes.UNAVAILABLE,
        message,
      });
    },
  );

  it("rejects client tool calls that are not the agent consult tool", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.toolCall"],
      'talkHandlers["talk.client.toolCall"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "main",
        callId: "call-1",
        name: "unknown_tool",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });

    expect(mocks.chatSend).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "unsupported realtime Talk tool: unknown_tool",
    });
  });
});

describe("talk.client.steer handler", () => {
  const createSteerContext = (ownerConnId = "conn-1") =>
    ({
      chatAbortControllers: new Map([
        [
          "run-voice-1",
          {
            controller: new AbortController(),
            sessionId: "session-active",
            sessionKey: "agent:main:main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
            ownerConnId,
            kind: "chat-send",
          },
        ],
      ]),
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      sessionId: "session-active",
      active: true,
      queued: true,
      message: "Steered the active OpenClaw run.",
      speak: false,
      show: true,
      suppress: true,
    });
  });

  it("routes browser-owned voice steering through the shared agent control helper", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.steer"],
      'talkHandlers["talk.client.steer"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.steer" },
      params: {
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: createSteerContext(),
    });

    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      text: "use the safer plan",
      mode: "steer",
    });
    expectRespondOk(respond, {
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
    });
  });

  it("rejects steering for a session key owned by another connection", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.steer"],
      'talkHandlers["talk.client.steer"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.steer" },
      params: {
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: createSteerContext("conn-2"),
    });

    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "talk.client.steer requires an active browser-owned Talk run",
    });
  });

  it("rejects malformed client steering params", async () => {
    const respond = vi.fn();

    await expectDefined(
      talkHandlers["talk.client.steer"],
      'talkHandlers["talk.client.steer"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.steer" },
      params: {
        sessionKey: "agent:main:main",
        text: "",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {} as never,
    });

    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
    expectRespondError(respond, { code: ErrorCodes.INVALID_REQUEST });
  });
});

describe("talk.client.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds realtime launch defaults from talk.realtime", () => {
    expect(
      buildTalkRealtimeConfig({
        talk: {
          realtime: {
            vadThreshold: 0.45,
            silenceDurationMs: 650,
            prefixPaddingMs: 250,
            reasoningEffort: " low ",
          },
        },
      }),
    ).toMatchObject({
      vadThreshold: 0.45,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      reasoningEffort: "low",
    });
  });

  it("uses talk.realtime provider, model, voice, and instructions without reading speech provider config", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key", model: "gpt-realtime" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {
        sessionKey: "main",
        vadThreshold: 0.45,
        silenceDurationMs: 650,
        prefixPaddingMs: 250,
        reasoningEffort: "low",
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              provider: "elevenlabs",
              providers: { elevenlabs: { apiKey: "speech-key" } },
              realtime: {
                provider: "openai",
                providers: { openai: { apiKey: "openai-key" } },
                model: "gpt-realtime",
                voice: "alloy",
                instructions: "Speak warmly.",
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: "gpt-realtime",
    });
    const createInput = mockCallArg(createBrowserSession) as Record<string, unknown>;
    expectRecordFields(createInput, {
      model: "gpt-realtime",
      voice: "alloy",
      vadThreshold: 0.45,
      silenceDurationMs: 650,
      prefixPaddingMs: 250,
      reasoningEffort: "low",
    });
    expect(createInput.instructions).toContain("Additional realtime instructions:\nSpeak warmly.");
    expect(createInput.instructions).toContain("tool-backed actions");
    expect(createInput.instructions).toContain("Let me check that for you");
    expect(createInput).not.toHaveProperty("provider");
    expect(createInput).not.toHaveProperty("providers");
    expect(createInput).not.toHaveProperty("transport");
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("uses agents.defaults.voiceModel as the realtime default model", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-default",
      models: ["gpt-realtime-default"],
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key", model: "gpt-realtime-default" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "openai/gpt-realtime-default",
                },
              },
            },
            talk: {
              realtime: {
                providers: { openai: { apiKey: "openai-key" } },
                speakerVoiceId: "voice-123",
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: "gpt-realtime-default",
    });
    expectRecordFields(mockCallArg(createBrowserSession), {
      model: "gpt-realtime-default",
      voice: "voice-123",
    });
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("ignores voiceModel defaults that are not realtime voice models", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime",
      models: ["gpt-realtime"],
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "openai/gpt-4o-mini-tts",
                },
              },
            },
            talk: {
              realtime: {
                providers: { openai: { apiKey: "openai-key" } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: undefined,
    });
    const createInput = mockCallArg(createBrowserSession) as Record<string, unknown>;
    expect(createInput).not.toHaveProperty("model");
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("uses the first configured realtime voiceModel fallback", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const googleProvider = {
      id: "google",
      label: "Google Live",
      defaultModel: "gemini-live",
      models: ["gemini-live"],
      isConfigured: () => false,
      createBrowserSession: vi.fn(),
      createBridge: vi.fn(),
    };
    const openaiProvider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime-2",
      models: ["gpt-realtime-2"],
      isConfigured: ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
        providerConfig.apiKey === "openai-key",
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([googleProvider, openaiProvider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider: openaiProvider,
      providerConfig: { apiKey: "openai-key", model: "gpt-realtime-2" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "google/gemini-live",
                  fallbacks: ["openai/gpt-realtime-2"],
                },
              },
            },
            talk: {
              realtime: {
                providers: { openai: { apiKey: "openai-key" } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      defaultModel: "gpt-realtime-2",
    });
    expectRecordFields(mockCallArg(createBrowserSession), {
      model: "gpt-realtime-2",
    });
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("ignores voiceModel providers that do not register realtime voice", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      defaultModel: "gpt-realtime",
      models: ["gpt-realtime"],
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.listRealtimeVoiceProviders.mockReturnValue([provider] as never);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "elevenlabs/eleven_multilingual_v2",
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: undefined,
      providerConfigs: {},
      defaultModel: undefined,
    });
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("keeps voice-call realtime provider ahead of unrelated voiceModel defaults", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "openai-key" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "elevenlabs/eleven_multilingual_v2",
                },
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    realtime: {
                      provider: "openai",
                      providers: { openai: { apiKey: "openai-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "openai",
      providerConfigs: { openai: { apiKey: "openai-key" } },
      defaultModel: undefined,
    });
    expectRespondOk(respond, { provider: "openai", transport: "webrtc" });
  });

  it("uses a single talk.realtime provider config ahead of unrelated voiceModel defaults", async () => {
    const createBrowserSession = vi.fn(async (_input: unknown) => ({
      provider: "custom",
      transport: "webrtc" as const,
      clientSecret: "secret",
    }));
    const provider = {
      id: "custom",
      label: "Custom Realtime",
      isConfigured: () => true,
      createBrowserSession,
      createBridge: vi.fn(),
    };
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "custom-key" },
    });

    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: {},
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            agents: {
              defaults: {
                voiceModel: {
                  primary: "openai/gpt-realtime-default",
                },
              },
            },
            talk: {
              realtime: {
                providers: { custom: { apiKey: "custom-key" } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expectRecordFields(mockCallArg(mocks.resolveConfiguredRealtimeVoiceProvider), {
      configuredProviderId: "custom",
      providerConfigs: { custom: { apiKey: "custom-key" } },
      defaultModel: undefined,
    });
    expectRespondOk(respond, { provider: "custom", transport: "webrtc" });
  });

  it("rejects Gateway-owned transports on the client endpoint", async () => {
    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: { sessionKey: "main", mode: "realtime", transport: "gateway-relay" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig } as never,
    });

    expectRespondError(respond, {
      message: "talk.client.create is client-owned; use talk.session.create for gateway-relay",
    });
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();
  });

  it("rejects realtime brains the client endpoint cannot run", async () => {
    const respond = vi.fn();
    await expectDefined(
      talkHandlers["talk.client.create"],
      'talkHandlers["talk.client.create"] test invariant',
    )({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: { sessionKey: "main" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              realtime: {
                brain: "direct-tools",
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();
    expectRespondError(respond, {
      message: 'talk.client.create only supports brain="agent-consult"',
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
