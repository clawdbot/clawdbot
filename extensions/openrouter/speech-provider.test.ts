import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterSpeechProvider } from "./speech-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
    resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://openrouter.ai/api/v1",
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

function requireOpenRouterConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter speech config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter speech config request");
  }
  return request;
}

function requireOpenRouterPostRequest(): Record<string, unknown> {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected OpenRouter speech request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected OpenRouter speech request");
  }
  return request as Record<string, unknown>;
}

function requireHeaders(value: unknown): Headers {
  if (!(value instanceof Headers)) {
    throw new Error("expected OpenRouter speech request headers");
  }
  return value;
}

describe("openrouter speech provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("normalizes provider-owned speech config", () => {
    const provider = buildOpenRouterSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          openrouter: {
            apiKey: "sk-test",
            baseUrl: "https://openrouter.ai/v1/",
            modelId: "google/gemini-3.1-flash-tts-preview",
            voiceId: "Kore",
            speed: 1.1,
            responseFormat: " MP3 ",
            provider: {
              options: {
                openai: {
                  instructions: "Speak warmly.",
                },
              },
            },
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.1-flash-tts-preview",
      voice: "Kore",
      speed: 1.1,
      responseFormat: "mp3",
      provider: {
        options: {
          openai: {
            instructions: "Speak warmly.",
          },
        },
      },
    });
  });

  it("synthesizes OpenAI-compatible speech through OpenRouter", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      release,
    });

    const provider = buildOpenRouterSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {
        models: {
          providers: {
            openrouter: {
              apiKey: "sk-openrouter",
              baseUrl: "https://openrouter.ai/v1/",
            },
          },
        },
      } as never,
      providerConfig: {
        model: "openai/gpt-4o-mini-tts-2025-12-15",
        voice: "nova",
        speed: 1.2,
      },
      target: "voice-note",
      timeoutMs: 12_345,
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledOnce();
    expect(requireOpenRouterConfigRequest()).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      allowPrivateNetwork: false,
      defaultHeaders: {
        Authorization: "Bearer sk-openrouter",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      provider: "openrouter",
      capability: "audio",
      transport: "http",
    });
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireOpenRouterPostRequest();
    const headers = requireHeaders(request.headers);
    expect(Object.fromEntries(headers.entries())).toEqual({
      authorization: "Bearer sk-openrouter",
      "content-type": "application/json",
      "http-referer": "https://openclaw.ai",
      "x-openrouter-title": "OpenClaw",
    });
    expect(request).toEqual({
      url: "https://openrouter.ai/api/v1/audio/speech",
      headers,
      body: {
        model: "openai/gpt-4o-mini-tts-2025-12-15",
        input: "hello",
        voice: "nova",
        response_format: "mp3",
        speed: 1.2,
      },
      timeoutMs: 12_345,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });
    expect(result.audioBuffer).toEqual(Buffer.from([1, 2, 3]));
    expect(result.outputFormat).toBe("mp3");
    expect(result.fileExtension).toBe(".mp3");
    expect(result.voiceCompatible).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("defaults to a live-proven OpenRouter TTS model", () => {
    const provider = buildOpenRouterSpeechProvider();

    expect(
      provider.resolveConfig?.({ cfg: {} as never, rawConfig: {}, timeoutMs: 30_000 }),
    ).toEqual({
      model: "hexgrad/kokoro-82m",
      voice: "af_alloy",
      responseFormat: undefined,
      provider: undefined,
    });
  });

  it("uses OPENROUTER_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-env");
    const provider = buildOpenRouterSpeechProvider();

    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });
});
