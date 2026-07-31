// Xai tests cover speech provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildXaiSpeechProvider } from "./speech-provider.js";

const {
  xaiTTSMock,
  listXaiTtsVoicesMock,
  xaiTTSStreamMock,
  isProviderAuthProfileConfiguredMock,
  resolveApiKeyForProviderMock,
} = vi.hoisted(() => ({
  xaiTTSMock: vi.fn(async () => Buffer.from("audio-bytes")),
  listXaiTtsVoicesMock: vi.fn(async () => [{ id: "altair", name: "Altair" }]),
  xaiTTSStreamMock: vi.fn(async () => ({
    audioStream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
    release: vi.fn(async () => {}),
  })),
  isProviderAuthProfileConfiguredMock: vi.fn(() => false),
  resolveApiKeyForProviderMock: vi.fn(
    async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined }),
  ),
}));

vi.mock("./tts.js", () => ({
  XAI_BASE_URL: "https://api.x.ai/v1",
  XAI_TTS_FALLBACK_VOICES: ["ara", "eve", "leo", "rex", "sal"],
  isValidXaiTtsVoice: (voice: string) => voice.trim().length > 0,
  listXaiTtsVoices: listXaiTtsVoicesMock,
  normalizeXaiLanguageCode: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined,
  normalizeXaiTtsBaseUrl: (baseUrl?: string) =>
    baseUrl?.trim().replace(/\/+$/, "") || "https://api.x.ai/v1",
  xaiTTS: xaiTTSMock,
  xaiTTSStream: xaiTTSStreamMock,
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
    xaiTTSMock.mockClear();
    xaiTTSStreamMock.mockClear();
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    listXaiTtsVoicesMock.mockReset();
    listXaiTtsVoicesMock.mockResolvedValue([{ id: "altair", name: "Altair" }]);
    delete process.env.XAI_API_KEY;
    delete process.env.XAI_BASE_URL;
  });

  it("forces self-describing mp3 for voice-note streaming", async () => {
    const provider = buildXaiSpeechProvider();
    const result = await provider.streamSynthesize?.({
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
        responseFormat: "pcm",
      },
      target: "voice-note",
      timeoutMs: 5_000,
    });

    expect(result?.outputFormat).toBe("mp3");
    expect(result?.fileExtension).toBe(".mp3");
    expect(result?.voiceCompatible).toBe(false);
    expect(result?.audioStream).toBeInstanceOf(ReadableStream);
    const streamParams = (
      xaiTTSStreamMock.mock.calls as unknown as Array<[Record<string, unknown>]>
    ).at(-1)?.[0];
    expect(streamParams).toMatchObject({
      text: "hello",
      apiKey: "xai-key",
      voiceId: "eve",
      responseFormat: "mp3",
      maxBytes: 2 * 1024 * 1024,
    });
    await result?.release?.();
  });

  it.each(["mp3", "wav", "pcm", "mulaw", "alaw"] as const)(
    "streams %s when requested by a compatible caller",
    async (responseFormat) => {
      const provider = buildXaiSpeechProvider();

      const result = await provider.streamSynthesize?.({
        text: "hello",
        cfg: {},
        providerConfig: {
          apiKey: "xai-key",
          responseFormat,
        },
        target: "audio-file",
        timeoutMs: 5_000,
      });
      expect(result?.outputFormat).toBe(responseFormat);
      const streamParams = (
        xaiTTSStreamMock.mock.calls as unknown as Array<[Record<string, unknown>]>
      ).at(-1)?.[0];
      expect(streamParams?.responseFormat).toBe(responseFormat);
      await result?.release?.();
    },
  );

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
        responseFormat: "pcm",
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

  it("treats blank direct credentials as absent across readiness and requests", async () => {
    process.env.XAI_API_KEY = "   ";
    const provider = buildXaiSpeechProvider();
    const providerConfig = { apiKey: "   " };

    expect(provider.isConfigured({ cfg: {}, providerConfig, timeoutMs: 5_000 })).toBe(false);
    await expect(provider.listVoices?.({ apiKey: "   ", providerConfig })).resolves.toEqual(
      ["ara", "eve", "leo", "rex", "sal"].map((voice) => ({ id: voice, name: voice })),
    );
    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {},
        providerConfig,
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("xAI credentials missing for TTS");

    expect(listXaiTtsVoicesMock).not.toHaveBeenCalled();
    expect(xaiTTSMock).not.toHaveBeenCalled();
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

  it("uses direct voice-list auth and URL overrides before configured sources", async () => {
    process.env.XAI_API_KEY = "env-key";
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();

    await provider.listVoices?.({
      apiKey: "request-key",
      baseUrl: "https://api.x.ai/v1/",
      providerConfig: {
        apiKey: "config-key",
        baseUrl: "https://config.example/v1",
      },
      cfg: {},
    });

    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "request-key",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });

  it("uses provider config auth before environment and profiles", async () => {
    process.env.XAI_API_KEY = "env-key";
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();

    await provider.listVoices?.({
      providerConfig: {
        apiKey: "config-key",
        baseUrl: "https://config.example/v1/",
      },
      cfg: {},
    });

    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "config-key",
      baseUrl: "https://config.example/v1",
    });
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });

  it("uses environment auth before profiles for voice discovery", async () => {
    process.env.XAI_API_KEY = "env-key";
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();

    await provider.listVoices?.({ providerConfig: {}, cfg: {} });

    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "env-key",
      baseUrl: "https://api.x.ai/v1",
    });
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });

  it("uses the environment-only base URL for voice discovery", async () => {
    process.env.XAI_API_KEY = "env-key";
    process.env.XAI_BASE_URL = "https://env.example/v1/";
    const provider = buildXaiSpeechProvider();

    await provider.listVoices?.({ providerConfig: {}, cfg: {} });

    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "env-key",
      baseUrl: "https://env.example/v1",
    });
  });

  it("uses cfg-scoped profile auth for voice discovery", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "oauth-bearer" });
    const provider = buildXaiSpeechProvider();
    const cfg = { agents: { defaults: {} } };

    await provider.listVoices?.({ providerConfig: {}, cfg });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({ provider: "xai", cfg });
    expect(listXaiTtsVoicesMock).toHaveBeenCalledWith({
      apiKey: "oauth-bearer",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("returns the five offline fallback voices only when auth is absent", async () => {
    const provider = buildXaiSpeechProvider();

    await expect(provider.listVoices?.({ providerConfig: {} })).resolves.toEqual([
      { id: "ara", name: "ara" },
      { id: "eve", name: "eve" },
      { id: "leo", name: "leo" },
      { id: "rex", name: "rex" },
      { id: "sal", name: "sal" },
    ]);
    expect(listXaiTtsVoicesMock).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalled();
  });

  it("does not mask authenticated catalog failures with offline voices", async () => {
    listXaiTtsVoicesMock.mockRejectedValueOnce(new Error("catalog unavailable"));
    const provider = buildXaiSpeechProvider();

    await expect(
      provider.listVoices?.({ providerConfig: { apiKey: "bad-key" }, cfg: {} }),
    ).rejects.toThrow("catalog unavailable");
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
