import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildLitellmImageGenerationProvider } from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadlineMock,
  resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequestMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "litellm-key" })),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  createProviderOperationDeadlineMock: vi.fn((params: Record<string, unknown>) => params),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined as unknown,
  })),
  resolveProviderOperationTimeoutMsMock: vi.fn(
    (params: Record<string, unknown>) => params.defaultTimeoutMs,
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  createProviderOperationDeadline: createProviderOperationDeadlineMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  resolveProviderOperationTimeoutMs: resolveProviderOperationTimeoutMsMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.resetModules();
});

function mockGeneratedPngResponse() {
  postJsonRequestMock.mockResolvedValue({
    response: {
      json: async () => ({
        data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
      }),
    },
    release: vi.fn(async () => {}),
  });
}

function mockObjectArg(mock: unknown, index = -1): Record<string, unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const call = index < 0 ? calls.at(index) : calls[index];
  const [arg] = call ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock object argument ${index}`);
  }
  return arg as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("litellm image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
  });

  it("declares litellm id and OpenAI-compatible size hints", () => {
    const provider = buildLitellmImageGenerationProvider();

    expect(provider.id).toBe("litellm");
    expect(provider.label).toBe("LiteLLM");
    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.capabilities.geometry?.sizes).toContain("1024x1024");
    expect(provider.capabilities.geometry?.sizes).toContain("2048x2048");
    expect(provider.capabilities.geometry?.sizes).toContain("3840x2160");
    expect(provider.capabilities.edit?.enabled).toBe(true);
  });

  it("defaults to the loopback proxy and allows private network for localhost", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {},
    });

    expectFields(mockObjectArg(resolveProviderHttpRequestConfigMock), {
      baseUrl: "http://localhost:4000",
      allowPrivateNetwork: true,
    });
    expectFields(mockObjectArg(postJsonRequestMock), {
      url: "http://localhost:4000/images/generations",
      allowPrivateNetwork: true,
    });
  });

  it("honors configured baseUrl and keeps private-network off for public endpoints", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "campaign hero",
      cfg: {
        models: {
          providers: {
            litellm: {
              baseUrl: "https://proxy.example.com/v1",
              models: [],
            },
          },
        },
      },
    });

    expectFields(mockObjectArg(resolveProviderHttpRequestConfigMock), {
      baseUrl: "https://proxy.example.com/v1",
      allowPrivateNetwork: undefined,
    });
    expectFields(mockObjectArg(postJsonRequestMock), {
      url: "https://proxy.example.com/v1/images/generations",
      allowPrivateNetwork: false,
    });
  });

  it("forwards count and size overrides on generation requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "dall-e-3",
      prompt: "two landscape variants",
      cfg: {},
      count: 2,
      size: "3840x2160",
    });

    expectFields(mockObjectArg(postJsonRequestMock), {
      url: "http://localhost:4000/images/generations",
      body: {
        model: "dall-e-3",
        prompt: "two landscape variants",
        n: 2,
        size: "3840x2160",
      },
    });
  });

  it("routes to the edit endpoint when input images are provided", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "refine the hero",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("fake-input"),
          mimeType: "image/png",
        },
      ],
    });

    expect(mockObjectArg(postJsonRequestMock).url).toBe("http://localhost:4000/images/edits");
    const call = postJsonRequestMock.mock.calls.at(0)?.[0] as { body: { images: unknown[] } };
    expect(call.body.images).toHaveLength(1);
  });

  it("throws a clear error when the API key is missing", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "" });

    const provider = buildLitellmImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "litellm",
        model: "gpt-image-2",
        prompt: "x",
        cfg: {},
      }),
    ).rejects.toThrow("LiteLLM API key missing");
  });

  it("forwards dispatcherPolicy from resolveProviderHttpRequestConfig to postJsonRequest", async () => {
    const dispatcherPolicy = { proxyUrl: "http://corp-proxy:3128" } as unknown;
    resolveProviderHttpRequestConfigMock.mockReturnValueOnce({
      baseUrl: "https://proxy.example.com/v1",
      allowPrivateNetwork: false,
      headers: new Headers({ Authorization: "Bearer litellm-key" }),
      dispatcherPolicy,
    });
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "hi",
      cfg: {
        models: {
          providers: {
            litellm: { baseUrl: "https://proxy.example.com/v1", models: [] },
          },
        },
      },
    });

    expect(mockObjectArg(postJsonRequestMock).dispatcherPolicy).toBe(dispatcherPolicy);
  });

  it("auto-allows private network for loopback-style baseUrls", async () => {
    const cases = [
      "http://localhost:4000",
      "http://127.0.0.1:4000",
      "http://[::1]:4000",
      "http://host.docker.internal:4000",
      "https://localhost:4000",
    ] as const;
    for (const baseUrl of cases) {
      resolveProviderHttpRequestConfigMock.mockClear();
      mockGeneratedPngResponse();
      const provider = buildLitellmImageGenerationProvider();
      await provider.generateImage({
        provider: "litellm",
        model: "gpt-image-2",
        prompt: "x",
        cfg: { models: { providers: { litellm: { baseUrl, models: [] } } } },
      });
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected allowPrivateNetwork=true for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", true);
    }
  });

  it("requires explicit private-network opt-in for LAN and internal baseUrls", async () => {
    const cases = [
      "http://10.0.0.42:4000",
      "http://192.168.5.10:4000",
      "http://172.16.0.5:4000",
      "https://192.168.5.10:4000",
      "http://printer.local:4000",
      "http://proxy.internal:4000",
      "https://metadata.google.internal",
    ] as const;
    for (const baseUrl of cases) {
      resolveProviderHttpRequestConfigMock.mockClear();
      mockGeneratedPngResponse();
      const provider = buildLitellmImageGenerationProvider();
      await provider.generateImage({
        provider: "litellm",
        model: "gpt-image-2",
        prompt: "x",
        cfg: { models: { providers: { litellm: { baseUrl, models: [] } } } },
      });
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected no automatic allowPrivateNetwork for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", undefined);
      expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(false);
    }
  });

  it("honors explicit private-network opt-in for a LAN LiteLLM proxy", async () => {
    mockGeneratedPngResponse();

    const provider = buildLitellmImageGenerationProvider();
    await provider.generateImage({
      provider: "litellm",
      model: "gpt-image-2",
      prompt: "x",
      cfg: {
        models: {
          providers: {
            litellm: {
              baseUrl: "http://192.168.5.10:4000",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
    });

    expectFields(mockObjectArg(resolveProviderHttpRequestConfigMock), {
      allowPrivateNetwork: undefined,
      request: { allowPrivateNetwork: true },
    });
    expect(mockObjectArg(postJsonRequestMock).allowPrivateNetwork).toBe(true);
  });

  it("does not allow private network for public hosts that embed private strings in the URL", async () => {
    // Must not be fooled by an attacker-controlled URL that mentions
    // "host.docker.internal" (or any private-looking literal) in the path,
    // query string, or fragment. Only the parsed hostname should count.
    const cases = [
      "https://evil.example.com/?target=host.docker.internal",
      "https://evil.example.com/host.docker.internal/foo",
      "https://evil.example.com/redirect?to=127.0.0.1",
      "https://public-api.openai.com/v1",
    ] as const;
    for (const baseUrl of cases) {
      resolveProviderHttpRequestConfigMock.mockClear();
      mockGeneratedPngResponse();
      const provider = buildLitellmImageGenerationProvider();
      await provider.generateImage({
        provider: "litellm",
        model: "gpt-image-2",
        prompt: "x",
        cfg: { models: { providers: { litellm: { baseUrl, models: [] } } } },
      });
      expect(
        mockObjectArg(resolveProviderHttpRequestConfigMock),
        `expected allowPrivateNetwork=false for ${baseUrl}`,
      ).toHaveProperty("allowPrivateNetwork", undefined);
    }
  });
});
