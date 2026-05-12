import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraSpeechProvider } from "./speech-provider.js";

const { assertOkOrThrowHttpErrorMock, postJsonRequestMock, resolveProviderHttpRequestConfigMock } =
  vi.hoisted(() => ({
    assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
    postJsonRequestMock: vi.fn(),
    resolveProviderHttpRequestConfigMock: vi.fn((params: Record<string, unknown>) => ({
      baseUrl: params.baseUrl ?? params.defaultBaseUrl ?? "https://api.deepinfra.com/v1/openai",
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

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

function requireFirstPostJsonRequest(): unknown {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected DeepInfra speech request");
  }
  return call[0];
}

describe("deepinfra speech provider", () => {
  afterEach(() => {
    assertOkOrThrowHttpErrorMock.mockClear();
    postJsonRequestMock.mockReset();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("normalizes provider-owned speech config", () => {
    const provider = buildDeepInfraSpeechProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      timeoutMs: 30_000,
      rawConfig: {
        providers: {
          deepinfra: {
            apiKey: "sk-test",
            baseUrl: "https://api.deepinfra.com/v1/openai/",
            modelId: "deepinfra/hexgrad/Kokoro-82M",
            voiceId: "af_alloy",
            speed: 1.1,
            responseFormat: " MP3 ",
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      model: "hexgrad/Kokoro-82M",
      voice: "af_alloy",
      speed: 1.1,
      responseFormat: "mp3",
      extraBody: undefined,
    });
  });

  it("synthesizes OpenAI-compatible speech through DeepInfra", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      release,
    });

    const provider = buildDeepInfraSpeechProvider();
    const result = await provider.synthesize({
      text: "hello",
      cfg: {
        models: {
          providers: {
            deepinfra: {
              apiKey: "sk-deepinfra",
              baseUrl: "https://api.deepinfra.com/v1/openai/",
            },
          },
        },
      } as never,
      providerConfig: {
        model: "hexgrad/Kokoro-82M",
        voice: "af_alloy",
        speed: 1.2,
      },
      target: "voice-note",
      timeoutMs: 12_345,
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
      [
        {
          baseUrl: "https://api.deepinfra.com/v1/openai",
          defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: "Bearer sk-deepinfra",
            "Content-Type": "application/json",
          },
          provider: "deepinfra",
          capability: "audio",
          transport: "http",
        },
      ],
    ]);
    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest();
    const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
    expect(postRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((postRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer sk-deepinfra",
      "content-type": "application/json",
    });
    expect(postRequest).toEqual({
      url: "https://api.deepinfra.com/v1/openai/audio/speech",
      headers: postRequestHeaders,
      timeoutMs: 12_345,
      body: {
        model: "hexgrad/Kokoro-82M",
        input: "hello",
        voice: "af_alloy",
        response_format: "mp3",
        speed: 1.2,
      },
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

  it("uses DEEPINFRA_API_KEY when provider config omits apiKey", () => {
    vi.stubEnv("DEEPINFRA_API_KEY", "sk-env");
    const provider = buildDeepInfraSpeechProvider();

    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: {},
        timeoutMs: 30_000,
      }),
    ).toBe(true);
  });
});
