// Openai tests cover image generation provider plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

const {
  ensureAuthProfileStoreMock,
  isProviderApiKeyConfiguredMock,
  listProfilesForProviderMock,
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
  logInfoMock,
} = vi.hoisted(() => ({
  ensureAuthProfileStoreMock: vi.fn(() => ({ version: 1, profiles: {} })),
  isProviderApiKeyConfiguredMock: vi.fn<
    (params: { provider: string; agentDir?: string }) => boolean
  >(() => false),
  listProfilesForProviderMock: vi.fn(
    (store: { profiles?: Record<string, { provider?: string }> }, provider: string) =>
      Object.entries(store.profiles ?? {})
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId),
  ),
  resolveApiKeyForProviderMock: vi.fn(
    async (_params?: {
      provider?: string;
    }): Promise<{ apiKey?: string; source?: string; mode?: string }> => ({
      apiKey: "openai-key",
    }),
  ),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => {
    const headers = new Headers(params.defaultHeaders);
    new Headers(params.headers).forEach((value, key) => headers.set(key, value));
    return {
      baseUrl: params.baseUrl ?? params.defaultBaseUrl,
      allowPrivateNetwork: Boolean(
        params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork,
      ),
      headers,
      dispatcherPolicy: undefined,
    };
  }),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
  logInfoMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStore: ensureAuthProfileStoreMock,
  isProviderApiKeyConfigured: isProviderApiKeyConfiguredMock,
  listProfilesForProvider: listProfilesForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  // Pass-through: bounded-reader enforcement is tested via bounded-reader unit tests.
  readProviderJsonResponse: async (response: { json(): Promise<unknown> }) => response.json(),
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest: sanitizeConfiguredModelProviderRequestMock,
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

function mockGeneratedPngResponse() {
  const response = {
    json: async () => ({
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64") }],
    }),
  };
  postJsonRequestMock.mockResolvedValue({
    response,
    release: vi.fn(async () => {}),
  });
  postMultipartRequestMock.mockResolvedValue({
    response,
    release: vi.fn(async () => {}),
  });
}

function mockCodexImageStream(params: { imageData?: string; revisedPrompt?: string } = {}) {
  const image = Buffer.from(params.imageData ?? "codex-png-bytes").toString("base64");
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        result: image,
        ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
      },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        tool_usage: { image_gen: { total_tokens: 30 } },
      },
    },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(body),
    release: vi.fn(async () => {}),
  }));
}

function mockCodexCompletedImageStream(
  params: {
    imageData?: string;
    revisedPrompt?: string;
  } = {},
) {
  const image = Buffer.from(params.imageData ?? "codex-completed-png-bytes").toString("base64");
  const events = [
    {
      type: "response.completed",
      response: {
        output: [
          {
            type: "image_generation_call",
            result: image,
            ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
          },
        ],
        usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      },
    },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(body),
    release: vi.fn(async () => {}),
  }));
}

function mockCodexRawStream(body: string) {
  postJsonRequestMock.mockImplementation(async () => ({
    response: new Response(body),
    release: vi.fn(async () => {}),
  }));
}

function mockCodexAuthOnly() {
  resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
    if (params?.provider === "openai") {
      return { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" };
    }
    return {};
  });
}

function createCodexOAuthAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:default": {
        type: "oauth" as const,
        provider: "openai",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
}

function createCodexApiKeyAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:manual": {
        type: "api_key" as const,
        provider: "openai",
        key: "codex-api-key",
      },
    },
  };
}

function createCodexTokenAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:token": {
        type: "token" as const,
        provider: "openai",
        token: "codex-token",
      },
    },
  };
}

function createMixedCodexAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      ...createCodexTokenAuthStore().profiles,
      ...createCodexApiKeyAuthStore().profiles,
    },
  };
}

function createMixedOpenAIAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai:chatgpt": {
        type: "oauth" as const,
        provider: "openai",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60_000,
      },
      "openai:default": {
        type: "api_key" as const,
        provider: "openai",
        key: "openai-key",
      },
    },
  };
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type HttpConfigCall = {
  allowPrivateNetwork?: boolean;
  api?: string;
  baseUrl?: string;
  capability?: string;
  defaultBaseUrl?: string;
  defaultHeaders?: Record<string, string>;
  provider?: string;
  request?: unknown;
};

type RequestCall = {
  allowPrivateNetwork?: boolean;
  body?: unknown;
  dispatcherPolicy?: unknown;
  fetchFn?: typeof fetch;
  headers?: Headers;
  ssrfPolicy?: unknown;
  timeoutMs?: number;
  url?: string;
};

type AuthResolutionCall = {
  cfg?: {
    models?: {
      providers?: {
        openai?: {
          auth?: string;
        };
      };
    };
  };
  credentialPrecedence?: string;
  provider?: string;
  store?: unknown;
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function jsonRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postJsonRequestMock, callIndex) as RequestCall;
}

function multipartRequestCall(callIndex = 0): RequestCall {
  return mockCallArg(postMultipartRequestMock, callIndex) as RequestCall;
}

function httpConfigCall(callIndex = 0): HttpConfigCall {
  return mockCallArg(resolveProviderHttpRequestConfigMock, callIndex) as HttpConfigCall;
}

function authResolutionCall(callIndex = 0): AuthResolutionCall {
  return mockCallArg(resolveApiKeyForProviderMock, callIndex) as AuthResolutionCall;
}

function expectNoJsonRequestUrl(expectedUrl: string) {
  expect(
    postJsonRequestMock.mock.calls.some(([call]) => (call as RequestCall).url === expectedUrl),
  ).toBe(false);
}

function expectNoJsonRequestUrlContaining(expectedFragment: string) {
  expect(
    postJsonRequestMock.mock.calls.some(
      ([call]) => (call as RequestCall).url?.includes(expectedFragment) === true,
    ),
  ).toBe(false);
}

describe("openai image generation provider", () => {
  afterEach(() => {
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    isProviderApiKeyConfiguredMock.mockReset();
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    listProfilesForProviderMock.mockClear();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openai-key" });
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    sanitizeConfiguredModelProviderRequestMock.mockClear();
    logInfoMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("advertises the current OpenAI image model and 2K/4K size hints", () => {
    const provider = buildOpenAIImageGenerationProvider();

    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.models).toEqual([
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1",
      "gpt-image-1-mini",
    ]);
    expect(provider.capabilities.geometry?.sizes).toContain("2048x2048");
    expect(provider.capabilities.geometry?.sizes).toContain("3840x2160");
    expect(provider.capabilities.geometry?.sizes).toContain("2160x3840");
    expect(provider.capabilities.output).toEqual({
      formats: ["png", "jpeg", "webp"],
      qualities: ["low", "medium", "high", "auto"],
      backgrounds: ["transparent", "opaque", "auto"],
    });
  });

  it("reports configured when either OpenAI API key auth or Codex OAuth auth is available", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockReturnValue(true);
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
    });

    isProviderApiKeyConfiguredMock.mockClear();
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue(createCodexOAuthAuthStore());
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
    });
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
    });

    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it("does not report Codex OAuth image auth as configured for custom OpenAI endpoints", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockReturnValue(false);

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://openai-compatible.example.test/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", () => {
    const provider = buildOpenAIImageGenerationProvider();

    // Config-only auth: a provider apiKey in config, with no env var and no
    // auth profile.
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://gateway.example.test/openai/v1",
                apiKey: "gateway-token",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("treats a %s config apiKey as not configured", (_label, apiKey) => {
    const provider = buildOpenAIImageGenerationProvider();

    // Blank placeholders resolve to no usable credential in the generate
    // path, so readiness must not count them either.
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://gateway.example.test/openai/v1",
                apiKey,
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue(createCodexOAuthAuthStore());

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://chatgpt.com/backend-api/codex",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-chatgpt-responses",
                baseUrl: "https://openai-compatible.example.test/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not report OpenAI OAuth image auth as configured for custom OpenAI endpoints", () => {
    const provider = buildOpenAIImageGenerationProvider();
    vi.stubEnv("OPENAI_API_KEY", "");
    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
        },
      },
    });

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://openai-compatible.example.test/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("does not report Codex OAuth image auth as configured for non-exact public OpenAI URLs", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockReturnValue(false);

    expect(
      provider.isConfigured?.({
        agentDir: "/tmp/agent",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1?proxy=1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("does not auto-allow local baseUrl overrides for image requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(httpConfigCall().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(jsonRequestCall().url).toBe("http://127.0.0.1:44080/v1/images/generations");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(false);
    expect(result.images).toHaveLength(1);
  });

  it("allows OpenAI-compatible private image endpoints when browser SSRF policy opts in", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "flux2-klein",
      prompt: "A simple, clean illustration of a red apple with a green leaf",
      cfg: {
        browser: {
          ssrfPolicy: {
            dangerouslyAllowPrivateNetwork: true,
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "http://192.168.1.15:8082/v1",
              apiKey: "local-noauth",
              models: [],
            },
          },
        },
      },
    });

    expect(httpConfigCall().baseUrl).toBe("http://192.168.1.15:8082/v1");
    expect(httpConfigCall().allowPrivateNetwork).toBe(true);
    expect(jsonRequestCall().url).toBe("http://192.168.1.15:8082/v1/images/generations");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it("propagates request SSRF policy to JSON image requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "test",
      cfg: {},
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(jsonRequestCall().ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
  });

  it("wraps malformed successful OpenAI image responses", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: { json: async () => ({ data: { b64_json: "not-an-array" } }) },
      release: vi.fn(async () => {}),
    });

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "bad shape",
        cfg: {},
      }),
    ).rejects.toThrow("OpenAI image generation response malformed");
  });

  it("forwards generation count and custom size overrides", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Create two landscape campaign variants",
      cfg: {},
      count: 2,
      size: "3840x2160",
    });

    const request = jsonRequestCall();
    expect(request.url).toBe("https://api.openai.com/v1/images/generations");
    expect(request.body).toEqual({
      model: "gpt-image-2",
      prompt: "Create two landscape campaign variants",
      n: 2,
      size: "3840x2160",
    });
    expect(result.images).toHaveLength(1);
  });

  it("normalizes legacy gpt-image-1 sizes before native OpenAI generation", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "Create a wide Matrix QA image",
      cfg: {},
      size: "2048x1152",
    });

    const request = jsonRequestCall();
    const body = request.body as Record<string, unknown>;
    expect(request.url).toBe("https://api.openai.com/v1/images/generations");
    expect(body.model).toBe("gpt-image-1");
    expect(body.size).toBe("1536x1024");
    expect(result.metadata).toEqual({
      requestedSize: "2048x1152",
      normalizedSize: "1536x1024",
    });
  });

  it("does not normalize model-specific sizes for custom OpenAI-compatible endpoints", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "Create a wide local-provider image",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai-compatible.example.com/v1",
              models: [],
            },
          },
        },
      },
      size: "2048x1152",
    });

    const request = jsonRequestCall();
    const body = request.body as Record<string, unknown>;
    expect(request.url).toBe("https://openai-compatible.example.com/v1/images/generations");
    expect(body.model).toBe("gpt-image-1");
    expect(body.size).toBe("2048x1152");
    expect(result.metadata).toBeUndefined();
  });

  it("forwards output and OpenAI-only options on direct generations", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Cheap JPEG preview",
      cfg: {},
      quality: "low",
      outputFormat: "jpeg",
      providerOptions: {
        openai: {
          background: "opaque",
          moderation: "low",
          outputCompression: 60,
          user: "end-user-42",
        },
      },
    });

    const request = jsonRequestCall();
    expect(request.url).toBe("https://api.openai.com/v1/images/generations");
    expect(request.body).toEqual({
      model: "gpt-image-2",
      prompt: "Cheap JPEG preview",
      n: 1,
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
      background: "opaque",
      moderation: "low",
      output_compression: 60,
      user: "end-user-42",
    });
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
    expect(result.images[0]?.fileName).toBe("image-1.jpg");
  });

  it("omits output compression for PNG direct generations", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Transparent PNG",
      cfg: {},
      outputFormat: "png",
      providerOptions: {
        openai: {
          outputCompression: 60,
        },
      },
    });

    const body = jsonRequestCall().body as Record<string, unknown>;
    expect(body.output_format).toBe("png");
    expect(body.output_compression).toBeUndefined();
  });

  it("routes transparent default-model requests to the OpenAI image model that supports alpha", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Transparent sticker",
      cfg: {},
      outputFormat: "png",
      background: "transparent",
    });

    const request = jsonRequestCall();
    const body = request.body as Record<string, unknown>;
    expect(request.url).toBe("https://api.openai.com/v1/images/generations");
    expect(body.model).toBe("gpt-image-1.5");
    expect(body.output_format).toBe("png");
    expect(body.background).toBe("transparent");
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("does not reroute transparent requests for custom OpenAI-compatible endpoints", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Transparent custom endpoint sticker",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai-compatible.example.com/v1",
              models: [],
            },
          },
        },
      },
      outputFormat: "png",
      providerOptions: {
        openai: {
          background: "transparent",
        },
      },
    });

    const request = jsonRequestCall();
    const body = request.body as Record<string, unknown>;
    expect(request.url).toBe("https://openai-compatible.example.com/v1/images/generations");
    expect(body.model).toBe("gpt-image-2");
    expect(body.output_format).toBe("png");
    expect(body.background).toBe("transparent");
  });

  it("allows loopback image requests for the synthetic mock-openai provider", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "mock-openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(httpConfigCall().allowPrivateNetwork).toBe(true);
    expect(jsonRequestCall().url).toBe("http://127.0.0.1:44080/v1/images/generations");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it("allows loopback image requests for openai only inside the QA harness envelope", async () => {
    mockGeneratedPngResponse();
    vi.stubEnv("OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER", "1");

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a QA lighthouse",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(httpConfigCall().allowPrivateNetwork).toBe(true);
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it("forwards edit count, custom size, and multiple input images", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Change only the background to pale blue",
      cfg: {},
      count: 2,
      size: "1024x1536",
      inputImages: [
        {
          buffer: Buffer.from("png-bytes"),
          mimeType: "image/png",
          fileName: "reference.png",
        },
        {
          buffer: Buffer.from("jpeg-bytes"),
          mimeType: "image/jpeg",
        },
      ],
    });

    const editCallArgs = multipartRequestCall() as RequestCall & {
      headers: Headers;
      body: FormData;
    };
    expect(editCallArgs.url).toBe("https://api.openai.com/v1/images/edits");
    expect(editCallArgs.body).toBeInstanceOf(FormData);
    expect(editCallArgs.allowPrivateNetwork).toBe(false);
    expect(editCallArgs.dispatcherPolicy).toBeUndefined();
    expect(editCallArgs.fetchFn).toBe(fetch);
    expect(editCallArgs.headers.has("Content-Type")).toBe(false);
    const form = editCallArgs.body;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Change only the background to pale blue");
    expect(form.get("n")).toBe("2");
    expect(form.get("size")).toBe("1024x1536");
    const images = form.getAll("image[]") as File[];
    expect(images).toHaveLength(2);
    expect(images[0]?.name).toBe("reference.png");
    expect(images[0]?.type).toBe("image/png");
    expect(images[1]?.name).toBe("image-2.jpg");
    expect(images[1]?.type).toBe("image/jpeg");
    expectNoJsonRequestUrl("https://api.openai.com/v1/images/edits");
    expect(result.images).toHaveLength(1);
  });

  it("forwards output and OpenAI-only options on multipart edits", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Edit as WebP",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      quality: "high",
      outputFormat: "webp",
      providerOptions: {
        openai: {
          background: "transparent",
          moderation: "auto",
          outputCompression: 75,
          user: "end-user-99",
        },
      },
    });

    const editCallArgs = multipartRequestCall() as RequestCall & {
      body: FormData;
    };
    const form = editCallArgs.body;
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("webp");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("moderation")).toBe("auto");
    expect(form.get("output_compression")).toBe("75");
    expect(form.get("user")).toBe("end-user-99");
    expect(result.images[0]?.mimeType).toBe("image/webp");
    expect(result.images[0]?.fileName).toBe("image-1.webp");
  });

  it("falls back to Codex OAuth image generation through Responses streaming", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image", revisedPrompt: "revised codex prompt" });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a Codex lighthouse",
      cfg: {},
      authStore,
      count: 1,
      size: "1024x1536",
      quality: "low",
      outputFormat: "jpeg",
      providerOptions: {
        openai: {
          background: "opaque",
          outputCompression: 55,
        },
      },
    });

    expect(authResolutionCall(0).provider).toBe("openai");
    expect(authResolutionCall(0).store).toBe(authStore);
    const configCall = httpConfigCall();
    expect(configCall.defaultBaseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(configCall.defaultHeaders).toEqual({
      Authorization: "Bearer codex-key",
      Accept: "text/event-stream",
    });
    expect(configCall.provider).toBe("openai");
    expect(configCall.api).toBe("openai-chatgpt-responses");
    expect(configCall.capability).toBe("image");
    const request = jsonRequestCall();
    const body = request.body as Record<string, unknown>;
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(request.timeoutMs).toBe(180_000);
    expect(body.model).toBe("gpt-5.5");
    expect(body.instructions).toBe("You are an image generation assistant.");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([
      {
        type: "image_generation",
        model: "gpt-image-2",
        size: "1024x1536",
        quality: "low",
        output_format: "jpeg",
        background: "opaque",
        output_compression: 55,
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith(
      "image auth selected: provider=openai mode=oauth transport=codex-responses requestedModel=gpt-image-2 responsesModel=gpt-5.5 timeoutMs=180000",
    );
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("codex-image"),
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "revised codex prompt",
      },
    ]);
    expect(result.metadata).toEqual({
      responses: [
        {
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
          toolUsage: { image_gen: { total_tokens: 30 } },
        },
      ],
    });
  });

  it("cancels oversized Codex OAuth image response streams", async () => {
    mockCodexAuthOnly();
    let canceled = false;
    let chunkSent = false;
    const release = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkSent) {
          return;
        }
        chunkSent = true;
        controller.enqueue(new Uint8Array(64 * 1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    postJsonRequestMock.mockResolvedValue({
      response: new Response(stream),
      release,
    });

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw an oversized Codex lighthouse",
        cfg: {},
        authStore: createCodexOAuthAuthStore(),
      }),
    ).rejects.toThrow("OpenAI Codex image generation response exceeded size limit");
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not treat Codex API key profiles as configured Codex OAuth image auth", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "openai-key", source: "profile:openai", mode: "api-key" };
      }
      throw new Error(`Unexpected auth provider ${params?.provider ?? ""}`);
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw with OpenAI auth despite a Codex API key profile",
      cfg: {},
      authStore: createCodexApiKeyAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(httpConfigCall().provider).toBe("openai");
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("transport=codex-responses"),
    );
  });

  it("uses native OpenAI image requests when only Codex API key auth is available", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return {
          apiKey: "codex-api-key",
          source: "profile:openai:manual",
          mode: "api-key",
        };
      }
      return {};
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw through Codex API key auth",
      cfg: {},
      authStore: createCodexApiKeyAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    const configCall = httpConfigCall();
    expect(configCall.defaultBaseUrl).toBe("https://api.openai.com/v1");
    expect(configCall.defaultHeaders).toEqual({
      Authorization: "Bearer codex-api-key",
    });
    expect(configCall.provider).toBe("openai");
    expect(configCall.api).toBeUndefined();
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("transport=codex-responses"),
    );
  });

  it("uses native OpenAI image requests when mixed Codex profiles resolve to an API key", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return {
          apiKey: "codex-api-key",
          source: "profile:openai:manual",
          mode: "api-key",
        };
      }
      throw new Error(`Unexpected auth provider ${params?.provider ?? ""}`);
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw through resolved Codex API key auth",
      cfg: {},
      authStore: createMixedCodexAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(httpConfigCall().defaultBaseUrl).toBe("https://api.openai.com/v1");
    expect(httpConfigCall().defaultHeaders).toEqual({
      Authorization: "Bearer codex-api-key",
    });
    expect(httpConfigCall().provider).toBe("openai");
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("transport=codex-responses"),
    );
  });

  it("keeps Codex token auth on the Codex image transport", async () => {
    mockCodexImageStream({ imageData: "codex-token-image" });
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return {
          apiKey: "codex-token",
          source: "profile:openai:token",
          mode: "token",
        };
      }
      return {};
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw through Codex token auth",
      cfg: {},
      authStore: createCodexTokenAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(httpConfigCall().defaultBaseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(httpConfigCall().provider).toBe("openai");
    expect(httpConfigCall().api).toBe("openai-chatgpt-responses");
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
    expect(result.images[0]?.buffer).toEqual(Buffer.from("codex-token-image"));
  });

  it("uses configured Codex token auth before probing an available OpenAI API key", async () => {
    mockCodexImageStream({ imageData: "codex-token-image" });
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return {
          apiKey: "codex-token",
          source: "profile:openai:token",
          mode: "token",
        };
      }
      return {};
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using configured Codex token auth",
      cfg: {},
      authStore: createCodexTokenAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("routes transparent default-model Codex OAuth requests to the alpha-capable image model", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-transparent-image" });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a transparent Codex sticker",
      cfg: {},
      authStore: { version: 1, profiles: {} },
      outputFormat: "png",
      providerOptions: {
        openai: {
          background: "transparent",
        },
      },
    });

    const request = jsonRequestCall();
    const body = request.body as { tools?: Array<Record<string, unknown>> };
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(body.tools?.[0]?.type).toBe("image_generation");
    expect(body.tools?.[0]?.model).toBe("gpt-image-1.5");
    expect(body.tools?.[0]?.output_format).toBe("png");
    expect(body.tools?.[0]?.background).toBe("transparent");
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("forwards OpenAI moderation into Codex Responses image-generation tool requests", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-moderated-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a low-moderation Codex preview",
      cfg: {},
      authStore: { version: 1, profiles: {} },
      providerOptions: {
        openai: {
          moderation: "low",
        },
      },
    });

    const request = jsonRequestCall();
    const body = request.body as { tools?: Array<Record<string, unknown>> };
    expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(body.tools?.[0]?.type).toBe("image_generation");
    expect(body.tools?.[0]?.moderation).toBe("low");
  });

  it("omits output compression for PNG Codex image requests", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-png-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw a transparent Codex badge",
      cfg: {},
      authStore: { version: 1, profiles: {} },
      outputFormat: "png",
      providerOptions: {
        openai: {
          outputCompression: 55,
        },
      },
    });

    const body = jsonRequestCall().body as { tools?: Array<Record<string, unknown>> };
    expect(body.tools?.[0]?.output_format).toBe("png");
    expect(body.tools?.[0]?.output_compression).toBeUndefined();
  });

  it("uses configured Codex OAuth directly instead of probing an available OpenAI API key", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" };
      }
      return {};
    });
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = createCodexOAuthAuthStore();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using configured Codex auth",
      cfg: {},
      authStore,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(authResolutionCall().store).toBe(authStore);
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(logInfoMock).toHaveBeenCalledWith(
      "image auth selected: provider=openai mode=oauth transport=codex-responses requestedModel=gpt-image-2 responsesModel=gpt-5.5 timeoutMs=180000",
    );
    expect(result.images[0]?.buffer).toEqual(Buffer.from("codex-image"));
  });

  it("keeps explicit OpenAI API-key image config on native image requests", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: AuthResolutionCall) => {
      if (params?.cfg?.models?.providers?.openai?.auth === "api-key") {
        return { apiKey: "configured-openai-key", source: "models.json", mode: "api-key" };
      }
      return { apiKey: "chatgpt-oauth-token", source: "profile:openai:chatgpt", mode: "oauth" };
    });
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = createMixedOpenAIAuthStore();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using configured OpenAI image auth",
      cfg: {
        models: {
          providers: {
            openai: {
              apiKey: "sk-configured",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      authStore,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(authResolutionCall().store).toBe(authStore);
    expect(authResolutionCall().credentialPrecedence).toBe("env-first");
    expect(authResolutionCall().cfg?.models?.providers?.openai?.auth).toBe("api-key");
    expect(httpConfigCall().defaultBaseUrl).toBe("https://api.openai.com/v1");
    expect(httpConfigCall().defaultHeaders).toEqual({
      Authorization: "Bearer configured-openai-key",
    });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it("does not fall back to Codex OAuth for custom OpenAI-compatible image endpoints", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw through a custom endpoint",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://openai-compatible.example.test/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).rejects.toThrow("OpenAI API key missing");

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("does not fall back to Codex OAuth for non-exact public OpenAI URLs", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw through public OpenAI with query params",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1?proxy=1",
                models: [],
              },
            },
          },
        },
      }),
    ).rejects.toThrow("OpenAI API key missing");

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("does not fall back to Codex OAuth when direct OpenAI auth resolution fails unexpectedly", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        throw new Error("Keychain unavailable");
      }
      return {};
    });
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw after an auth error",
        cfg: {},
      }),
    ).rejects.toThrow("Keychain unavailable");

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("sanitizes Codex OAuth image auth log values", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return {
          apiKey: "codex-key",
          source: "profile:openai:default",
          mode: "oauth\nfake\u202eignored",
        };
      }
      return {};
    });
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2\r\nforged=true\u2028next",
      prompt: "Draw using configured Codex auth",
      cfg: {},
      authStore: createCodexOAuthAuthStore(),
    });

    expect(logInfoMock).toHaveBeenCalledWith(
      "image auth selected: provider=openai mode=oauth fakeignored transport=codex-responses requestedModel=gpt-image-2 forged=true next responsesModel=gpt-5.5 timeoutMs=180000",
    );
  });

  it("does not split a surrogate pair when truncating Codex OAuth image auth log values", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: `${"a".repeat(255)}😀tail`,
      prompt: "Draw using configured Codex auth",
      cfg: {},
      authStore: createCodexOAuthAuthStore(),
    });

    expect(logInfoMock).toHaveBeenCalledWith(
      `image auth selected: provider=openai mode=oauth transport=codex-responses requestedModel=${"a".repeat(255)}... responsesModel=gpt-5.5 timeoutMs=180000`,
    );
  });

  it("parses Codex completed response output image payloads", async () => {
    mockCodexAuthOnly();
    mockCodexCompletedImageStream({
      imageData: "codex-completed-image",
      revisedPrompt: "completed prompt",
    });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw from completed output",
      cfg: {},
    });

    expect(result.images).toEqual([
      {
        buffer: Buffer.from("codex-completed-image"),
        mimeType: "image/png",
        fileName: "image-1.png",
        revisedPrompt: "completed prompt",
      },
    ]);
    expect(result.metadata).toEqual({
      responses: [
        {
          usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
          toolUsage: undefined,
        },
      ],
    });
  });

  it("honors configured Codex transport overrides for OAuth image generation", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = createCodexOAuthAuthStore();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw through a configured Codex endpoint",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44220/backend-api/codex",
              api: "openai-chatgpt-responses",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      authStore,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    expect(httpConfigCall().baseUrl).toBe("http://127.0.0.1:44220/backend-api/codex");
    expect(httpConfigCall().request).toEqual({ allowPrivateNetwork: true });
    expect(jsonRequestCall().url).toBe("http://127.0.0.1:44220/backend-api/codex/responses");
    expect(jsonRequestCall().allowPrivateNetwork).toBe(true);
    expect(jsonRequestCall().ssrfPolicy).toEqual({ allowRfc2544BenchmarkRange: true });
    expect(result.images[0]?.buffer).toEqual(Buffer.from("codex-image"));
  });

  it.each([
    "https://chatgpt.com/backend-api",
    "https://chatgpt.com/backend-api/",
    "https://chatgpt.com/backend-api/v1",
    "https://chatgpt.com/backend-api/codex/v1",
  ])("canonicalizes configured Codex OAuth image baseUrl %s", async (configuredBaseUrl) => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw through a legacy configured Codex endpoint",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: configuredBaseUrl,
              api: "openai-chatgpt-responses",
              models: [],
            },
          },
        },
      },
      authStore: createCodexOAuthAuthStore(),
    });

    expect(httpConfigCall().baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(httpConfigCall().provider).toBe("openai");
    expect(httpConfigCall().api).toBe("openai-chatgpt-responses");
    expect(httpConfigCall().capability).toBe("image");
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("uses direct OpenAI auth when custom OpenAI image config is explicit", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "openai-key", source: "models.json", mode: "api-key" };
      }
      if (params?.provider === "openai") {
        return { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" };
      }
      return {};
    });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = createCodexOAuthAuthStore();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using explicit direct config",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "OPENAI_API_KEY",
              models: [],
            },
          },
        },
      },
      authStore,
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(authResolutionCall().store).toBe(authStore);
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
  });

  it("keeps explicit OpenAI request settings on native image requests", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "openai-key", source: "models.json", mode: "api-key" };
      }
      if (params?.provider === "openai") {
        return { apiKey: "codex-key", source: "profile:openai:default", mode: "oauth" };
      }
      return {};
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using explicit request settings",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              headers: { "X-Test-OpenAI": "direct" },
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      authStore: createCodexOAuthAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(httpConfigCall().api).toBe("openai-responses");
    expect(httpConfigCall().request).toEqual({ allowPrivateNetwork: true });
    expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    expect(jsonRequestCall().headers?.get("X-Test-OpenAI")).toBe("direct");
    expectNoJsonRequestUrl("https://chatgpt.com/backend-api/codex/responses");
  });

  it("keeps mixed OpenAI OAuth/API-key image auth on the selected OAuth transport", async () => {
    mockCodexImageStream();
    resolveApiKeyForProviderMock.mockResolvedValue({
      apiKey: "codex-key",
      source: "profile:openai:chatgpt",
      mode: "oauth",
    });

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw using the selected ChatGPT profile",
      cfg: {
        auth: {
          profiles: {
            "openai:chatgpt": {
              provider: "openai",
              mode: "oauth",
            },
            "openai:default": {
              provider: "openai",
              mode: "api_key",
            },
          },
          order: {
            openai: ["openai:chatgpt", "openai:default"],
          },
        },
      },
      authStore: createMixedOpenAIAuthStore(),
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledTimes(1);
    expect(authResolutionCall().provider).toBe("openai");
    expect(httpConfigCall().provider).toBe("openai");
    expect(httpConfigCall().api).toBe("openai-chatgpt-responses");
    expect(jsonRequestCall().url).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("sends Codex reference images as Responses input images", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream();

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Use the reference image",
      cfg: {},
      inputImages: [
        { buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "ref.png" },
      ],
    });

    const body = postJsonRequestMock.mock.calls[0]?.[0].body as {
      input: Array<{ content: Array<Record<string, string>> }>;
    };
    expect(body.input[0]?.content).toEqual([
      { type: "input_text", text: "Use the reference image" },
      {
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
        detail: "auto",
      },
    ]);
    expectNoJsonRequestUrlContaining("/images/edits");
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
  });

  it("satisfies Codex count by issuing one Responses request per image", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw two Codex icons",
      cfg: {},
      count: 2,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(2);
    const firstBody = postJsonRequestMock.mock.calls[0]?.[0].body as {
      tools: Array<Record<string, unknown>>;
    };
    expect(firstBody.tools[0]).toEqual({
      type: "image_generation",
      model: "gpt-image-2",
      size: "1024x1024",
    });
    expect(result.images.map((image) => image.fileName)).toEqual(["image-1.png", "image-2.png"]);
  });

  it("caps Codex image request count at provider maximum", async () => {
    mockCodexAuthOnly();
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAIImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Draw many Codex icons",
      cfg: {},
      count: 12,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(4);
    expect(result.images.map((image) => image.fileName)).toEqual([
      "image-1.png",
      "image-2.png",
      "image-3.png",
      "image-4.png",
    ]);
  });

  it("rejects oversized Codex image SSE event streams", async () => {
    mockCodexAuthOnly();
    const body = Array.from(
      { length: 513 },
      (_, index) =>
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: String(index) })}\n\n`,
    ).join("");
    mockCodexRawStream(body);

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Draw after noisy SSE",
        cfg: {},
      }),
    ).rejects.toThrow("OpenAI Codex image generation response exceeded event limit");
  });

  it("forwards SSRF guard fields to multipart edit requests", async () => {
    mockGeneratedPngResponse();

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Edit cat",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    expect(multipartRequestCall().url).toBe("http://127.0.0.1:44080/v1/images/edits");
    expect(multipartRequestCall().allowPrivateNetwork).toBe(false);
    expect(multipartRequestCall().dispatcherPolicy).toBeUndefined();
    expect(multipartRequestCall().fetchFn).toBe(fetch);
    expectNoJsonRequestUrl("http://127.0.0.1:44080/v1/images/edits");
  });

  describe("azure openai support", () => {
    it("uses api-key header and deployment-scoped URL for Azure .openai.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(httpConfigCall().defaultHeaders).toEqual({ "api-key": "openai-key" });
      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
    });

    it("omits model from Azure generation body because deployment is URL-scoped", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2-1",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
      });

      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2-1/images/generations?api-version=2024-12-01-preview",
      );
      expect(jsonRequestCall().body).toEqual({
        prompt: "Azure cat",
        n: 1,
        size: "1024x1024",
      });
      expect(jsonRequestCall().timeoutMs).toBe(600_000);
    });

    it("lets explicit timeoutMs override the Azure image default", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2-1",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
        timeoutMs: 123_456,
      });

      expect(jsonRequestCall().timeoutMs).toBe(123_456);
    });

    it("does not reroute transparent background requests for Azure deployment names", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Transparent Azure sticker",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
        outputFormat: "png",
        providerOptions: {
          openai: {
            background: "transparent",
          },
        },
      });

      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
      expect(jsonRequestCall().body).toEqual({
        prompt: "Transparent Azure sticker",
        n: 1,
        size: "1024x1024",
        output_format: "png",
        background: "transparent",
      });
    });

    it("uses api-key header and deployment-scoped URL for .cognitiveservices.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.cognitiveservices.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(httpConfigCall().defaultHeaders).toEqual({ "api-key": "openai-key" });
      expect(jsonRequestCall().url).toBe(
        "https://myresource.cognitiveservices.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
    });

    it("uses api-key header and deployment-scoped URL for .services.ai.azure.com hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://my-resource.services.ai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(httpConfigCall().defaultHeaders).toEqual({ "api-key": "openai-key" });
      expect(jsonRequestCall().url).toBe(
        "https://my-resource.services.ai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
    });

    it("respects AZURE_OPENAI_API_VERSION env override", async () => {
      mockGeneratedPngResponse();
      vi.stubEnv("AZURE_OPENAI_API_VERSION", "2025-01-01");

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
      });

      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-01-01",
      );
    });

    it("builds Azure edit URL with deployment and api-version", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Change background",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com",
                models: [],
              },
            },
          },
        },
        inputImages: [
          {
            buffer: Buffer.from("png-bytes"),
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });

      expect(multipartRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/edits?api-version=2024-12-01-preview",
      );
      expect(multipartRequestCall().body).toBeInstanceOf(FormData);
    });

    it("omits model from Azure edit form because deployment is URL-scoped", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2-1",
        prompt: "Change background",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
        inputImages: [
          {
            buffer: Buffer.from("png-bytes"),
            mimeType: "image/png",
            fileName: "reference.png",
          },
        ],
      });

      const editCallArgs = multipartRequestCall() as RequestCall & {
        body: FormData;
      };
      expect(editCallArgs.body.has("model")).toBe(false);
      expect(editCallArgs.body.get("prompt")).toBe("Change background");
      expect(editCallArgs.body.get("size")).toBe("1024x1024");
    });

    it("strips trailing /v1 from Azure base URL", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/v1",
                models: [],
              },
            },
          },
        },
      });

      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
    });

    it("strips trailing /openai/v1 from Azure base URL", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Azure cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://myresource.openai.azure.com/openai/v1",
                models: [],
              },
            },
          },
        },
      });

      expect(jsonRequestCall().url).toBe(
        "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
      );
    });

    it("still uses Bearer auth for public OpenAI hosts", async () => {
      mockGeneratedPngResponse();

      const provider = buildOpenAIImageGenerationProvider();
      await provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "Public cat",
        cfg: {},
      });

      expect(httpConfigCall().defaultHeaders).toEqual({ Authorization: "Bearer openai-key" });
      expect(jsonRequestCall().url).toBe("https://api.openai.com/v1/images/generations");
    });
  });
});
