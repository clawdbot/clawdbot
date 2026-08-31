// OpenAI-compatible speech provider tests cover speech request and file output.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createOpenAiCompatibleSpeechProvider } from "./openai-compatible-speech-provider.js";
import { withSpeakerSelectionCompat, withSpeakerSelectionFallbackCompat } from "./speaker.js";
import { getResolvedSpeechProviderConfig } from "./tts-provider-resolution.js";
import { resolveTtsConfig } from "./tts-settings.js";

const providerState = vi.hoisted(() => ({
  provider: undefined as SpeechProviderPlugin | undefined,
}));

vi.mock("./provider-registry.js", async () => {
  const { createSpeechProviderRegistry, normalizeSpeechProviderId } =
    await import("./provider-registry-core.js");
  return {
    ...createSpeechProviderRegistry({
      getProvider: () => providerState.provider,
      listProviders: () => (providerState.provider ? [providerState.provider] : []),
    }),
    normalizeSpeechProviderId,
  };
});

const {
  assertOkOrThrowHttpErrorMock,
  postJsonRequestMock,
  readProviderBinaryResponseMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  postJsonRequestMock: vi.fn(),
  readProviderBinaryResponseMock: vi.fn(async (response: Response, label: string) => {
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType === "application/json" || contentType?.startsWith("text/")) {
      throw new Error(`${label}: malformed audio response`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`${label}: malformed audio response`);
    }
    return bytes;
  }),
  resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://example.test/v1",
    allowPrivateNetwork: false,
    headers: new Headers(params.defaultHeaders as HeadersInit | undefined),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  readProviderBinaryResponse: readProviderBinaryResponseMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("missing first mock call");
  }
  const [arg] = call;
  if (!arg || typeof arg !== "object") {
    throw new Error("missing first mock argument");
  }
  return arg as Record<string, unknown>;
}

describe("createOpenAiCompatibleSpeechProvider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    readProviderBinaryResponseMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    providerState.provider = undefined;
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "canonical name before canonical id and legacy aliases",
      selection: {
        speakerVoice: " cedar ",
        speakerVoiceId: "canonical-id",
        voice: "legacy",
        voiceId: "legacy-id",
      },
      expected: "cedar",
    },
    {
      name: "canonical id before a legacy name",
      selection: { speakerVoiceId: " canonical-id ", voice: "legacy", voiceId: "legacy-id" },
      expected: "canonical-id",
    },
    {
      name: "canonical id after a blank canonical name",
      selection: { speakerVoice: " ", speakerVoiceId: " canonical-id ", voice: "legacy" },
      expected: "canonical-id",
    },
    {
      name: "legacy name after blank canonical fields",
      selection: {
        speakerVoice: " ",
        speakerVoiceId: " ",
        voice: " legacy ",
        voiceId: "legacy-id",
      },
      expected: "legacy",
    },
    {
      name: "legacy id after a blank legacy name",
      selection: { speakerVoice: " ", speakerVoiceId: " ", voice: " ", voiceId: " legacy-id " },
      expected: "legacy-id",
    },
    { name: "provider default without a selection", selection: {}, expected: "alloy" },
  ])(
    "preserves $name through direct, normalized, runtime, and Talk synthesis",
    async ({ selection, expected }) => {
      const provider = createOpenAiCompatibleSpeechProvider({
        id: "demo",
        label: "Demo",
        autoSelectOrder: 40,
        models: ["demo-tts"],
        voices: ["alloy"],
        defaultModel: "demo-tts",
        defaultVoice: "alloy",
        defaultBaseUrl: "https://example.test/v1",
        envKey: "DEMO_API_KEY",
        responseFormats: ["mp3"],
        defaultResponseFormat: "mp3",
        voiceCompatibleResponseFormats: ["mp3"],
      });
      providerState.provider = provider;
      postJsonRequestMock.mockImplementation(async () => ({
        response: new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
        release: async () => {},
      }));
      const providerConfig = { apiKey: "test-key", ...selection };
      const rawConfig = { provider: "demo", providers: { demo: providerConfig } };
      const cfg = { tts: rawConfig };
      const normalized = provider.resolveConfig?.({ cfg, rawConfig, timeoutMs: 1000 });
      const resolved = getResolvedSpeechProviderConfig(resolveTtsConfig(cfg), "demo", cfg);
      const talkConfig = provider.resolveTalkConfig?.({
        cfg,
        baseTtsConfig: { providers: { demo: { apiKey: "test-key", voice: "base-voice" } } },
        talkProviderConfig: withSpeakerSelectionFallbackCompat(selection),
        timeoutMs: 1000,
      });
      const inheritedTalkConfig = provider.resolveTalkConfig?.({
        cfg,
        baseTtsConfig: { providers: { demo: withSpeakerSelectionCompat(providerConfig) } },
        talkProviderConfig: { speakerVoice: " ", speakerVoiceId: " ", voice: " ", voiceId: " " },
        timeoutMs: 1000,
      });
      for (const config of [
        providerConfig,
        expectDefined(normalized, "normalized provider config"),
        resolved,
        expectDefined(talkConfig, "Talk provider config"),
        expectDefined(inheritedTalkConfig, "inherited Talk provider config"),
      ]) {
        await provider.synthesize({
          text: "Voice precedence",
          cfg,
          providerConfig: config,
          target: "audio-file",
          timeoutMs: 1000,
        });
      }
      expect(postJsonRequestMock.mock.calls.map(([request]) => request.body.voice)).toEqual([
        expected,
        expected,
        expected,
        Object.keys(selection).length === 0 ? "base-voice" : expected,
        expected,
      ]);
      expect(providerConfig).toEqual({ apiKey: "test-key", ...selection });
    },
  );

  it("normalizes config with built-in base URL policies and preserves secret error paths", () => {
    const provider = createOpenAiCompatibleSpeechProvider({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/api/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3", "pcm"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["mp3"],
      baseUrlPolicy: {
        kind: "canonical",
        aliases: ["https://example.test/v1"],
      },
    });

    expect(provider.defaultModel).toBe("demo-tts");
    expect(
      provider.resolveConfig?.({
        cfg: {} as never,
        timeoutMs: 30_000,
        rawConfig: {
          providers: {
            demo: {
              apiKey: "sk-demo",
              baseUrl: "https://example.test/v1/",
              modelId: "custom-tts",
              voiceId: "nova",
              speed: 1.25,
              responseFormat: " PCM ",
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "sk-demo",
      baseUrl: "https://example.test/api/v1",
      model: "custom-tts",
      voice: "nova",
      speed: 1.25,
      responseFormat: "pcm",
    });
    const apiKey = { source: "env", provider: "default", id: "UNRESOLVED_SPEECH_KEY" } as const;
    expect(() =>
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: { providers: { demo: { apiKey } } },
        timeoutMs: 1000,
      }),
    ).toThrow("tts.providers.demo.apiKey");
    expect(() =>
      provider.resolveTalkConfig?.({
        cfg: {},
        baseTtsConfig: {},
        talkProviderConfig: { apiKey },
        timeoutMs: 1000,
      }),
    ).toThrow("talk.providers.demo.apiKey");
  });

  it("maps configured extra JSON body fields into synthesis requests", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider<{
      routing?: Record<string, unknown>;
    }>({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3", "opus"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["opus"],
      baseUrlPolicy: { kind: "trim-trailing-slash" },
      readExtraConfig: (raw) =>
        typeof raw?.routing === "object" && raw.routing !== null && !Array.isArray(raw.routing)
          ? { routing: raw.routing as Record<string, unknown> }
          : {},
      extraJsonBodyFields: [{ configKey: "routing", requestKey: "provider" }],
    });

    const result = await provider.synthesize({
      text: "hello",
      cfg: {} as never,
      providerConfig: {
        baseUrl: "https://example.test/v1/",
        responseFormat: "opus",
        routing: { order: ["openai"] },
      },
      providerOverrides: {
        modelId: "override-tts",
        voiceId: "verse",
        speed: 1.1,
      },
      target: "voice-note",
      timeoutMs: 1234,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    const httpConfigRequest = requireFirstMockArg(resolveProviderHttpRequestConfigMock);
    expect(httpConfigRequest.baseUrl).toBe("https://example.test/v1");
    expect(httpConfigRequest.defaultBaseUrl).toBe("https://example.test/v1");
    expect(httpConfigRequest.provider).toBe("demo");
    expect(httpConfigRequest.capability).toBe("audio");

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstMockArg(postJsonRequestMock);
    expect(postRequest.url).toBe("https://example.test/v1/audio/speech");
    expect(postRequest.timeoutMs).toBe(1234);
    expect(postRequest.body).toStrictEqual({
      model: "override-tts",
      input: "hello",
      voice: "verse",
      response_format: "opus",
      speed: 1.1,
      provider: { order: ["openai"] },
    });
    expect(result.audioBuffer).toStrictEqual(Buffer.from([4, 5, 6]));
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects JSON success bodies from TTS responses as malformed audio", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: "not audio" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["mp3"],
    });

    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig: {},
        target: "voice-note",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Demo TTS API error: malformed audio response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects empty successful TTS bodies as malformed audio", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array(), { status: 200 }),
      release,
    });
    vi.stubEnv("DEMO_API_KEY", "sk-env");

    const provider = createOpenAiCompatibleSpeechProvider({
      id: "demo",
      label: "Demo",
      autoSelectOrder: 40,
      models: ["demo-tts"],
      voices: ["alloy"],
      defaultModel: "demo-tts",
      defaultVoice: "alloy",
      defaultBaseUrl: "https://example.test/v1",
      envKey: "DEMO_API_KEY",
      responseFormats: ["mp3"],
      defaultResponseFormat: "mp3",
      voiceCompatibleResponseFormats: ["mp3"],
    });

    await expect(
      provider.synthesize({
        text: "hello",
        cfg: {} as never,
        providerConfig: {},
        target: "voice-note",
        timeoutMs: 1234,
      }),
    ).rejects.toThrow("Demo TTS API error: malformed audio response");
    expect(release).toHaveBeenCalledOnce();
  });
});
