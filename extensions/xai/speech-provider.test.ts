import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";

const { xaiTTSMock, isProviderAuthProfileConfiguredMock, resolveApiKeyForProviderMock } =
  vi.hoisted(() => ({
    xaiTTSMock: vi.fn(async () => Buffer.from("audio-bytes")),
    isProviderAuthProfileConfiguredMock: vi.fn(() => false),
    resolveApiKeyForProviderMock: vi.fn(
      async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined }),
    ),
  }));

vi.mock("./tts.js", () => ({
  XAI_BASE_URL: "https://api.x.ai/v1",
  XAI_TTS_VOICES: ["eve", "ara", "rex", "sal", "leo", "una"],
  isValidXaiTtsVoice: (voice: string) => ["eve", "ara", "rex", "sal", "leo", "una"].includes(voice),
  normalizeXaiLanguageCode: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined,
  normalizeXaiTtsBaseUrl: (baseUrl?: string) =>
    baseUrl?.trim().replace(/\/+$/, "") || "https://api.x.ai/v1",
  xaiTTS: xaiTTSMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

function requireLastTtsCall(): {
  text?: string;
  apiKey?: string;
  baseUrl?: string;
  voiceId?: string;
  language?: string;
  speed?: number;
  responseFormat?: string;
  maxBytes?: number;
} {
  const params = (xaiTTSMock.mock.calls as unknown as Array<[unknown]>).at(-1)?.[0] as
    | {
        text?: string;
        apiKey?: string;
        baseUrl?: string;
        voiceId?: string;
        language?: string;
        speed?: number;
        responseFormat?: string;
        maxBytes?: number;
      }
    | undefined;
  if (!params) {
    throw new Error("Expected xaiTTS call");
  }
  return params;
}

describe("xai speech provider", () => {
  afterEach(() => {
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
  });

  it("synthesizes mp3 audio and does not claim native voice-note compatibility", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {
        agents: {
          defaults: {
            mediaMaxMb: 2,
          },
        },
      },
      providerConfig: {
        apiKey: "xai-key",
        voiceId: "eve",
      },
      target: "voice-note",
      timeoutMs: 5_000,
    });

    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer.byteLength).toBeGreaterThan(0);
    const tts = requireLastTtsCall();
    expect(tts.text).toBe("hello");
    expect(tts.apiKey).toBe("xai-key");
    expect(tts.baseUrl).toBe("https://api.x.ai/v1");
    expect(tts.voiceId).toBe("eve");
    expect(tts.responseFormat).toBe("mp3");
    expect(tts.maxBytes).toBe(2 * 1024 * 1024);
  });

  it("honors configured response formats", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        responseFormat: "wav",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(requireLastTtsCall().responseFormat).toBe("wav");
  });

  it("honors voice, language, and speed overrides for telephony output", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
        voiceId: "eve",
        language: "en",
        speed: 1,
      },
      providerOverrides: {
        voice: "aura",
        language: "es",
        speed: 1.2,
      },
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      audioBuffer: Buffer.from("audio-bytes"),
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
    const tts = requireLastTtsCall();
    expect(tts.voiceId).toBe("aura");
    expect(tts.language).toBe("es");
    expect(tts.speed).toBe(1.2);
    expect(tts.responseFormat).toBe("pcm");
  });

  it("drops malformed speed values before synthesis", async () => {
    const provider = buildXaiSpeechProvider();
    await provider.synthesize({
      text: "hello",
      cfg: {},
      providerConfig: {
        apiKey: "xai-key",
        speed: 2,
      },
      providerOverrides: {
        speed: 0.5,
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requireLastTtsCall().speed).toBeUndefined();
  });

  it("reports configured when an xAI auth profile exists, even without env or config apiKey", () => {
    isProviderAuthProfileConfiguredMock.mockReturnValue(true);
    const provider = buildXaiSpeechProvider();
    expect(
      provider.isConfigured({
        cfg: {},
        providerConfig: {},
        timeoutMs: 5_000,
      }),
    ).toBe(true);
    expect(isProviderAuthProfileConfiguredMock).toHaveBeenCalledWith({
      provider: "xai",
      cfg: {},
    });
  });

  it("reports not configured when there is no apiKey, env, or auth profile", () => {
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    const provider = buildXaiSpeechProvider();
    expect(
      provider.isConfigured({
        cfg: {},
        providerConfig: {},
        timeoutMs: 5_000,
      }),
    ).toBe(false);
  });

  it("threads cfg into the OAuth fallback resolver when no direct apiKey is available", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();
    const cfg = { agents: { defaults: {} } };
    await provider.synthesize({
      text: "hello",
      cfg,
      providerConfig: {},
      target: "voice-note",
      timeoutMs: 5_000,
    });
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(requireLastTtsCall().apiKey).toBe("oauth-bearer");
  });
});
