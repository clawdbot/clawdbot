import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleSpeechProvider } from "./openai-compatible-speech-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
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
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
}));

describe("createOpenAiCompatibleSpeechProvider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("normalizes config with built-in base URL policies", () => {
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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://example.test/v1",
        defaultBaseUrl: "https://example.test/v1",
        provider: "demo",
        capability: "audio",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.test/v1/audio/speech",
        timeoutMs: 1234,
        body: {
          model: "override-tts",
          input: "hello",
          voice: "verse",
          response_format: "opus",
          speed: 1.1,
          provider: { order: ["openai"] },
        },
      }),
    );
    expect(result).toMatchObject({
      audioBuffer: Buffer.from([4, 5, 6]),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });
});
