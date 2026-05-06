import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { ErrorCodes } from "../protocol/index.js";
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
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) => providerId),
  listRealtimeVoiceProviders: vi.fn(() => []),
  listRealtimeTranscriptionProviders: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  createTalkRealtimeRelaySession: vi.fn(),
  sendTalkRealtimeRelayAudio: vi.fn(),
  cancelTalkRealtimeRelayTurn: vi.fn(),
  stopTalkRealtimeRelaySession: vi.fn(),
  registerTalkRealtimeRelayAgentRun: vi.fn(),
  submitTalkRealtimeRelayToolResult: vi.fn(),
  createTalkTranscriptionRelaySession: vi.fn(),
  sendTalkTranscriptionRelayAudio: vi.fn(),
  cancelTalkTranscriptionRelayTurn: vi.fn(),
  stopTalkTranscriptionRelaySession: vi.fn(),
  chatSend: vi.fn(),
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
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

vi.mock("../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
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
    cancelTalkRealtimeRelayTurn: mocks.cancelTalkRealtimeRelayTurn,
    createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
    registerTalkRealtimeRelayAgentRun: mocks.registerTalkRealtimeRelayAgentRun,
    sendTalkRealtimeRelayAudio: mocks.sendTalkRealtimeRelayAudio,
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
        defaultModel: "gpt-4o-transcribe",
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "stt-key"),
      } as never,
    ]);
    mocks.listRealtimeVoiceProviders.mockReturnValue([
      {
        id: "google",
        label: "Google Live Voice",
        defaultModel: "gemini-live",
        resolveConfig: vi.fn(({ rawConfig }) => rawConfig),
        isConfigured: vi.fn(({ providerConfig }) => providerConfig.apiKey === "live-key"),
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
    ]);

    const respond = vi.fn();
    await talkHandlers["talk.catalog"]({
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
                providers: { google: { apiKey: "live-key" } },
              },
            },
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "openai",
                      providers: { openai: { apiKey: "stt-key" } },
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
              configured: true,
              modes: ["stt-tts"],
              brains: ["agent-consult"],
              models: ["eleven_flash_v2_5"],
              voices: ["voice-1"],
            },
          ],
        },
        transcription: {
          activeProvider: "openai",
          providers: [
            {
              id: "openai",
              label: "OpenAI Realtime Transcription",
              configured: true,
              modes: ["transcription"],
              transports: ["gateway-relay"],
              brains: ["none"],
              defaultModel: "gpt-4o-transcribe",
            },
          ],
        },
        realtime: {
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
          ],
        },
      },
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("speech-key");
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("stt-key");
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("live-key");
  });
});

describe("talk.speak handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active runtime config snapshot instead of the raw config snapshot", async () => {
    const runtimeConfig = createTalkConfig("env-acme-key");
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
        talkProviderConfig,
      }: {
        talkProviderConfig: Record<string, unknown>;
      }) => talkProviderConfig,
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
    await talkHandlers["talk.speak"]({
      req: { type: "req", id: "1", method: "talk.speak" },
      params: { text: "Hello from talk mode." },
      client: null,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello from talk mode.",
        disableFallback: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "acme",
        audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
        outputFormat: "mp3",
        mimeType: "audio/mpeg",
        fileExtension: ".mp3",
      }),
      undefined,
    );
  });
});

describe("talk.config handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes runtime-resolved messages.tts provider secrets to strict provider resolvers", async () => {
    const sourceConfig = {
      talk: {
        provider: "acme",
        providers: {
          acme: {
            voiceId: "voice-from-talk-config",
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
        return {
          ...talkProviderConfig,
          ...(apiKey === undefined ? {} : { apiKey }),
        };
      },
    });

    const respond = vi.fn();
    await talkHandlers["talk.config"]({
      req: { type: "req", id: "1", method: "talk.config" },
      params: {},
      client: { connect: { scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => runtimeConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        config: {
          talk: expect.objectContaining({
            provider: "acme",
            resolved: {
              provider: "acme",
              config: expect.objectContaining({
                apiKey: "__OPENCLAW_REDACTED__",
              }),
            },
          }),
        },
      },
      undefined,
    );
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
  });

  it("creates and drives a realtime gateway-relay session through the unified API", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime",
      isConfigured: () => true,
      createBridge: vi.fn(),
    };
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
    await talkHandlers["talk.session.create"]({
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
            talk: {
              realtime: {
                provider: "openai",
                providers: { openai: { apiKey: "openai-key" } },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mocks.createTalkRealtimeRelaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        connId: "conn-1",
        provider,
        providerConfig: expect.objectContaining({
          apiKey: "openai-key",
          model: "gpt-realtime",
          voice: "alloy",
        }),
      }),
    );
    expect(createRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: "relay-unified-1",
        relaySessionId: "relay-unified-1",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      }),
      undefined,
    );

    const inputRespond = vi.fn();
    await talkHandlers["talk.session.appendAudio"]({
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
    await talkHandlers["talk.session.cancelOutput"]({
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

    const toolRespond = vi.fn();
    await talkHandlers["talk.session.submitToolResult"]({
      req: { type: "req", id: "4", method: "talk.session.submitToolResult" },
      params: { sessionId: "relay-unified-1", callId: "call-1", result: { ok: true } },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: toolRespond as never,
      context: {} as never,
    });
    expect(mocks.submitTalkRealtimeRelayToolResult).toHaveBeenCalledWith({
      relaySessionId: "relay-unified-1",
      connId: "conn-1",
      callId: "call-1",
      result: { ok: true },
    });

    const closeRespond = vi.fn();
    await talkHandlers["talk.session.close"]({
      req: { type: "req", id: "5", method: "talk.session.close" },
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

  it("creates transcription gateway-relay sessions through the unified API", async () => {
    const provider = {
      id: "openai",
      label: "OpenAI Realtime Transcription",
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
      audio: { inputEncoding: "pcm16", inputSampleRateHz: 24000 },
      expiresAt: 1_797_986_400,
    });

    const createRespond = vi.fn();
    await talkHandlers["talk.session.create"]({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: { mode: "transcription", provider: "openai" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            plugins: {
              entries: {
                "voice-call": {
                  config: {
                    streaming: {
                      provider: "openai",
                      providers: { openai: { apiKey: "stt-key" } },
                    },
                  },
                },
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(createRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: "stt-unified-1",
        transcriptionSessionId: "stt-unified-1",
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      }),
      undefined,
    );

    const inputRespond = vi.fn();
    await talkHandlers["talk.session.appendAudio"]({
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
    await talkHandlers["talk.session.close"]({
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

  it("creates and controls managed-room sessions through the unified API", async () => {
    const broadcastToConnIds = vi.fn();
    const createRespond = vi.fn();
    await talkHandlers["talk.session.create"]({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "session:main",
        ttlMs: 5000,
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });
    const session = createRespond.mock.calls[0]?.[1] as { sessionId: string; token: string };

    expect(createRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: expect.any(String),
        handoffId: expect.any(String),
        roomId: expect.stringMatching(/^talk_/),
        transport: "managed-room",
        brain: "agent-consult",
        token: expect.any(String),
      }),
      undefined,
    );
    expect(mocks.resolveSessionKeyFromResolveParams).toHaveBeenCalledWith({
      cfg: {},
      p: {
        key: "session:main",
        includeGlobal: true,
        includeUnknown: true,
      },
    });

    const joinRespond = vi.fn();
    await talkHandlers["talk.session.join"]({
      req: { type: "req", id: "2", method: "talk.session.join" },
      params: { sessionId: session.sessionId, token: session.token },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: joinRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    expect(joinRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        id: session.sessionId,
        room: expect.objectContaining({
          activeClientId: "conn-1",
        }),
      }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({
        handoffId: session.sessionId,
        talkEvent: expect.objectContaining({ type: "session.ready" }),
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );

    const startRespond = vi.fn();
    await talkHandlers["talk.session.startTurn"]({
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

    expect(startRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        turnId: "turn-1",
        events: [expect.objectContaining({ type: "turn.started", turnId: "turn-1" })],
      }),
      undefined,
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({
        handoffId: session.sessionId,
        talkEvent: expect.objectContaining({ type: "turn.started", turnId: "turn-1" }),
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );

    const closeRespond = vi.fn();
    await talkHandlers["talk.session.close"]({
      req: { type: "req", id: "4", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: closeRespond as never,
      context: {
        broadcastToConnIds,
      } as never,
    });
    expect(closeRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "talk.event",
      expect.objectContaining({
        handoffId: session.sessionId,
        talkEvent: expect.objectContaining({ type: "session.closed", final: true }),
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("requires managed-room ownership before turn control", async () => {
    const broadcastToConnIds = vi.fn();
    const createRespond = vi.fn();
    await talkHandlers["talk.session.create"]({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: {
        mode: "stt-tts",
        transport: "managed-room",
        sessionKey: "session:main",
      },
      client: { connId: "creator" } as never,
      isWebchatConnect: () => false,
      respond: createRespond as never,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
      } as never,
    });
    const session = createRespond.mock.calls[0]?.[1] as { sessionId: string; token: string };

    const unjoinedStartRespond = vi.fn();
    await talkHandlers["talk.session.startTurn"]({
      req: { type: "req", id: "2", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "creator" } as never,
      isWebchatConnect: () => false,
      respond: unjoinedStartRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expect(unjoinedStartRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "talk.session.startTurn requires the active managed-room connection",
      }),
    );

    await talkHandlers["talk.session.join"]({
      req: { type: "req", id: "3", method: "talk.session.join" },
      params: { sessionId: session.sessionId, token: session.token },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: { broadcastToConnIds } as never,
    });

    const staleStartRespond = vi.fn();
    await talkHandlers["talk.session.startTurn"]({
      req: { type: "req", id: "4", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleStartRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expect(staleStartRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "talk.session.startTurn requires the active managed-room connection",
      }),
    );

    await talkHandlers["talk.session.startTurn"]({
      req: { type: "req", id: "5", method: "talk.session.startTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: vi.fn() as never,
      context: { broadcastToConnIds } as never,
    });

    const staleEndRespond = vi.fn();
    await talkHandlers["talk.session.endTurn"]({
      req: { type: "req", id: "6", method: "talk.session.endTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleEndRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expect(staleEndRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "talk.session.endTurn requires the active managed-room connection",
      }),
    );

    const staleCancelRespond = vi.fn();
    await talkHandlers["talk.session.cancelTurn"]({
      req: { type: "req", id: "7", method: "talk.session.cancelTurn" },
      params: { sessionId: session.sessionId, turnId: "turn-1" },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleCancelRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expect(staleCancelRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "talk.session.cancelTurn requires the active managed-room connection",
      }),
    );

    const staleCloseRespond = vi.fn();
    await talkHandlers["talk.session.close"]({
      req: { type: "req", id: "8", method: "talk.session.close" },
      params: { sessionId: session.sessionId },
      client: { connId: "conn-2" } as never,
      isWebchatConnect: () => false,
      respond: staleCloseRespond as never,
      context: { broadcastToConnIds } as never,
    });
    expect(staleCloseRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "talk.session.close requires the active managed-room connection",
      }),
    );

    await talkHandlers["talk.session.close"]({
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
    await talkHandlers["talk.session.create"]({
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

    expect(rejectedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: 'talk.session.create brain="direct-tools" requires gateway scope: operator.admin',
      }),
    );
    expect(mocks.resolveSessionKeyFromResolveParams).not.toHaveBeenCalled();

    const createRespond = vi.fn();
    await talkHandlers["talk.session.create"]({
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

    const session = createRespond.mock.calls[0]?.[1] as { sessionId: string };
    expect(createRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: expect.any(String),
        transport: "managed-room",
        brain: "direct-tools",
      }),
      undefined,
    );

    await talkHandlers["talk.session.close"]({
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
    await talkHandlers["talk.session.create"]({
      req: { type: "req", id: "1", method: "talk.session.create" },
      params: { mode: "realtime", transport: "webrtc" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("use talk.client.create"),
      }),
    );
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

    await talkHandlers["talk.client.toolCall"]({
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

    expect(mocks.chatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ method: "chat.send" }),
        params: expect.objectContaining({
          sessionKey: "main",
          message: expect.stringContaining("What is in this repo?"),
          idempotencyKey: expect.stringMatching(/^talk-call-1-/),
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        runId: "run-voice-1",
        idempotencyKey: expect.stringMatching(/^talk-call-1-/),
      },
      undefined,
    );
  });

  it("links relay-owned agent consult runs so relay cancellation can abort them", async () => {
    const respond = vi.fn();

    await talkHandlers["talk.client.toolCall"]({
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
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "run-voice-1" }),
      undefined,
    );
  });

  it("rejects client tool calls that are not the agent consult tool", async () => {
    const respond = vi.fn();

    await talkHandlers["talk.client.toolCall"]({
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "unsupported realtime Talk tool: unknown_tool",
      }),
    );
  });
});

describe("talk.client.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses talk.realtime provider, model, and voice without reading speech provider config", async () => {
    const createBrowserSession = vi.fn(async () => ({
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
    await talkHandlers["talk.client.create"]({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: { sessionKey: "main" },
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
              },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(mocks.resolveConfiguredRealtimeVoiceProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProviderId: "openai",
        providerConfigs: { openai: { apiKey: "openai-key" } },
      }),
    );
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-realtime",
        voice: "alloy",
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "openai", transport: "webrtc" }),
      undefined,
    );
  });

  it("rejects Gateway-owned transports on the client endpoint", async () => {
    const respond = vi.fn();
    await talkHandlers["talk.client.create"]({
      req: { type: "req", id: "1", method: "talk.client.create" },
      params: { sessionKey: "main", mode: "realtime", transport: "gateway-relay" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: { getRuntimeConfig: () => ({}) as OpenClawConfig } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "talk.client.create is client-owned; use talk.session.create for gateway-relay",
      }),
    );
    expect(mocks.resolveConfiguredRealtimeVoiceProvider).not.toHaveBeenCalled();
  });

  it("rejects realtime brains the client endpoint cannot run", async () => {
    const respond = vi.fn();
    await talkHandlers["talk.client.create"]({
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: 'talk.client.create only supports brain="agent-consult"',
      }),
    );
  });
});
