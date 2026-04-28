import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeResolvedSecretInputString } from "../../config/types.secrets.js";
import { talkHandlers } from "./talk.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  readConfigFileSnapshot: vi.fn(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  synthesizeSpeech: vi.fn(),
  getRealtimeVoiceProvider: vi.fn(),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  createTalkRealtimeRelaySession: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../../tts/provider-registry.js", () => ({
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
}));

vi.mock("../../tts/tts.js", () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../realtime-voice/provider-registry.js", () => ({
  getRealtimeVoiceProvider: mocks.getRealtimeVoiceProvider,
}));

vi.mock("../../realtime-voice/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
}));

vi.mock("../talk-realtime-relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../talk-realtime-relay.js")>();
  return {
    ...actual,
    createTalkRealtimeRelaySession: mocks.createTalkRealtimeRelaySession,
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

describe("talk.realtime.session handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the gateway relay when Google returns a WebRTC-shaped browser session", async () => {
    const createBrowserSession = vi.fn(async () => ({
      provider: "google",
      clientSecret: "legacy-google-secret",
    }));
    const createBridge = vi.fn();
    const provider = {
      id: "google",
      label: "Google Live Voice",
      isConfigured: () => true,
      createBrowserSession,
      createBridge,
    };
    mocks.getRealtimeVoiceProvider.mockReturnValue(provider);
    mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
      provider,
      providerConfig: { apiKey: "gemini-key" },
    });
    mocks.createTalkRealtimeRelaySession.mockReturnValue({
      provider: "google",
      transport: "gateway-relay",
      relaySessionId: "relay-1",
      audio: {
        inputEncoding: "pcm16",
        inputSampleRateHz: 24000,
        outputEncoding: "pcm16",
        outputSampleRateHz: 24000,
      },
    });

    const respond = vi.fn();
    await talkHandlers["talk.realtime.session"]({
      req: { type: "req", id: "1", method: "talk.realtime.session" },
      params: { sessionKey: "main", provider: "google" },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond: respond as never,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              provider: "google",
              providers: { google: { apiKey: "gemini-key" } },
            },
          }) as OpenClawConfig,
      } as never,
    });

    expect(createBrowserSession).toHaveBeenCalledTimes(1);
    expect(mocks.createTalkRealtimeRelaySession).toHaveBeenCalledWith(
      expect.objectContaining({
        connId: "conn-1",
        provider,
        providerConfig: { apiKey: "gemini-key" },
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        provider: "google",
        transport: "gateway-relay",
        relaySessionId: "relay-1",
      }),
      undefined,
    );
  });
});
