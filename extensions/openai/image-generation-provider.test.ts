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
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  sanitizeConfiguredModelProviderRequestMock: vi.fn((request) => request),
  logInfoMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
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
    if (params?.provider === "openai-codex") {
      return { apiKey: "codex-key", source: "profile:openai-codex:default", mode: "oauth" };
    }
    return {};
  });
}

function createCodexOAuthAuthStore() {
  return {
    version: 1 as const,
    profiles: {
      "openai-codex:default": {
        type: "oauth" as const,
        provider: "openai-codex",
        access: "codex-access",
        refresh: "codex-refresh",
        expires: Date.now() + 60_000,
      },
    },
  };
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
    expect(provider.aliases).toContain("openai-codex");
    expect(provider.models).toEqual([
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1",
      "gpt-image-1-mini",
    ]);
    expect(provider.capabilities.geometry?.sizes).toEqual(
      expect.arrayContaining(["2048x2048", "3840x2160", "2160x3840"]),
    );
    expect(provider.capabilities.output).toEqual({
      formats: ["png", "jpeg", "webp"],
      qualities: ["low", "medium", "high", "auto"],
      backgrounds: ["transparent", "opaque", "auto"],
    });
  });

  it("reports configured when either OpenAI API key auth or Codex OAuth auth is available", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockImplementation((params?: { provider?: string }) => {
      return params?.provider === "openai";
    });
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
    });

    isProviderApiKeyConfiguredMock.mockClear();
    isProviderApiKeyConfiguredMock.mockImplementation((params?: { provider?: string }) => {
      return params?.provider === "openai-codex";
    });
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(true);
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
    });
    expect(isProviderApiKeyConfiguredMock).toHaveBeenCalledWith({
      provider: "openai-codex",
      agentDir: "/tmp/agent",
    });

    isProviderApiKeyConfiguredMock.mockReturnValue(false);
    expect(provider.isConfigured?.({ agentDir: "/tmp/agent" })).toBe(false);
  });

  it("does not report Codex OAuth image auth as configured for custom OpenAI endpoints", () => {
    const provider = buildOpenAIImageGenerationProvider();

    isProviderApiKeyConfiguredMock.mockImplementation((params?: { provider?: string }) => {
      return params?.provider === "openai-codex";
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

    isProviderApiKeyConfiguredMock.mockImplementation((params?: { provider?: string }) => {
      return params?.provider === "openai-codex";
    });

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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:44080/v1",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: false,
      }),
    );
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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://192.168.1.15:8082/v1",
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://192.168.1.15:8082/v1/images/generations",
        allowPrivateNetwork: true,
      }),
    );
    expect(result.images).toHaveLength(1);
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: {
          model: "gpt-image-2",
          prompt: "Create two landscape campaign variants",
          n: 2,
          size: "3840x2160",
        },
      }),
    );
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: expect.objectContaining({
          model: "gpt-image-1",
          size: "1536x1024",
        }),
      }),
    );
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openai-compatible.example.com/v1/images/generations",
        body: expect.objectContaining({
          model: "gpt-image-1",
          size: "2048x1152",
        }),
      }),
    );
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: {
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
        },
      }),
    );
    expect(result.images[0]).toMatchObject({
      mimeType: "image/jpeg",
      fileName: "image-1.jpg",
    });
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
        body: expect.objectContaining({
          model: "gpt-image-1.5",
          output_format: "png",
          background: "transparent",
        }),
      }),
    );
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openai-compatible.example.com/v1/images/generations",
        body: expect.objectContaining({
          model: "gpt-image-2",
          output_format: "png",
          background: "transparent",
        }),
      }),
    );
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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44080/v1/images/generations",
        allowPrivateNetwork: true,
      }),
    );
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

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowPrivateNetwork: true,
      }),
    );
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
          fileName: "style.jpg",
        },
      ],
    });

    expect(postMultipartRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/edits",
        body: expect.any(FormData),
        allowPrivateNetwork: false,
        dispatcherPolicy: undefined,
        fetchFn: fetch,
      }),
    );
    const editCallArgs = postMultipartRequestMock.mock.calls[0]?.[0] as {
      headers: Headers;
      body: FormData;
    };
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
    expect(images[1]?.name).toBe("style.jpg");
    expect(images[1]?.type).toBe("image/jpeg");
    expect(postJsonRequestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/images/edits" }),
    );
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

    const editCallArgs = postMultipartRequestMock.mock.calls[0]?.[0] as {
      body: FormData;
    };
    const form = editCallArgs.body;
    expect(form.get("quality")).toBe("high");
    expect(form.get("output_format")).toBe("webp");
    expect(form.get("background")).toBe("transparent");
    expect(form.get("moderation")).toBe("auto");
    expect(form.get("output_compression")).toBe("75");
    expect(form.get("user")).toBe("end-user-99");
    expect(result.images[0]).toMatchObject({
      mimeType: "image/webp",
      fileName: "image-1.webp",
    });
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

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        store: authStore,
      }),
    );
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultBaseUrl: "https://chatgpt.com/backend-api/codex",
        defaultHeaders: expect.objectContaining({
          Authorization: "Bearer codex-key",
          Accept: "text/event-stream",
        }),
        provider: "openai-codex",
        api: "openai-codex-responses",
        capability: "image",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chatgpt.com/backend-api/codex/responses",
        timeoutMs: 180_000,
        body: expect.objectContaining({
          model: "gpt-5.5",
          instructions: "You are an image generation assistant.",
          stream: true,
          store: false,
          tools: [
            {
              type: "image_generation",
              model: "gpt-image-2",
              size: "1024x1536",
              quality: "low",
              output_format: "jpeg",
              background: "opaque",
              output_compression: 55,
            },
          ],
          tool_choice: { type: "image_generation" },
        }),
      }),
    );
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith(
      "image auth selected: provider=openai-codex mode=oauth transport=codex-responses requestedModel=gpt-image-2 responsesModel=gpt-5.5 timeoutMs=180000",
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

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chatgpt.com/backend-api/codex/responses",
        body: expect.objectContaining({
          tools: [
            expect.objectContaining({
              type: "image_generation",
              model: "gpt-image-1.5",
              output_format: "png",
              background: "transparent",
            }),
          ],
        }),
      }),
    );
    expect(result.model).toBe("gpt-image-1.5");
  });

  it("uses configured Codex OAuth directly instead of probing an available OpenAI API key", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "openai-key", source: "OPENAI_API_KEY", mode: "api-key" };
      }
      if (params?.provider === "openai-codex") {
        return { apiKey: "codex-key", source: "profile:openai-codex:default", mode: "oauth" };
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
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        store: authStore,
      }),
    );
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chatgpt.com/backend-api/codex/responses",
      }),
    );
    expect(logInfoMock).toHaveBeenCalledWith(
      "image auth selected: provider=openai-codex mode=oauth transport=codex-responses requestedModel=gpt-image-2 responsesModel=gpt-5.5 timeoutMs=180000",
    );
    expect(result.images[0]?.buffer).toEqual(Buffer.from("codex-image"));
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
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
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
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("does not fall back to Codex OAuth when direct OpenAI auth resolution fails unexpectedly", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        throw new Error("Keychain unavailable");
      }
      if (params?.provider === "openai-codex") {
        return { apiKey: "codex-key", source: "profile:openai-codex:default", mode: "oauth" };
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
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("sanitizes Codex OAuth image auth log values", async () => {
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai-codex") {
        return {
          apiKey: "codex-key",
          source: "profile:openai-codex:default",
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
      "image auth selected: provider=openai-codex mode=oauth fakeignored transport=codex-responses requestedModel=gpt-image-2 forged=true next responsesModel=gpt-5.5 timeoutMs=180000",
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
            "openai-codex": {
              baseUrl: "http://127.0.0.1:44220/backend-api/codex",
              api: "openai-codex-responses",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      authStore,
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:44220/backend-api/codex",
        request: { allowPrivateNetwork: true },
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44220/backend-api/codex/responses",
        allowPrivateNetwork: true,
      }),
    );
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
            "openai-codex": {
              baseUrl: configuredBaseUrl,
              api: "openai-codex-responses",
              models: [],
            },
          },
        },
      },
      authStore: createCodexOAuthAuthStore(),
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        provider: "openai-codex",
        api: "openai-codex-responses",
        capability: "image",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://chatgpt.com/backend-api/codex/responses",
      }),
    );
  });

  it("uses direct OpenAI auth when custom OpenAI image config is explicit", async () => {
    mockGeneratedPngResponse();
    resolveApiKeyForProviderMock.mockImplementation(async (params?: { provider?: string }) => {
      if (params?.provider === "openai") {
        return { apiKey: "openai-key", source: "models.json", mode: "api-key" };
      }
      if (params?.provider === "openai-codex") {
        return { apiKey: "codex-key", source: "profile:openai-codex:default", mode: "oauth" };
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
    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(resolveApiKeyForProviderMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/images/generations",
      }),
    );
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
    expect(postJsonRequestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("/images/edits") }),
    );
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

    expect(postMultipartRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:44080/v1/images/edits",
        allowPrivateNetwork: false,
        dispatcherPolicy: undefined,
        fetchFn: fetch,
      }),
    );
    expect(postJsonRequestMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:44080/v1/images/edits" }),
    );
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

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2-1/images/generations?api-version=2024-12-01-preview",
          body: {
            prompt: "Azure cat",
            n: 1,
            size: "1024x1024",
          },
          timeoutMs: 600_000,
        }),
      );
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutMs: 123_456,
        }),
      );
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
          body: {
            prompt: "Transparent Azure sticker",
            n: 1,
            size: "1024x1024",
            output_format: "png",
            background: "transparent",
          },
        }),
      );
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

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.cognitiveservices.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
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

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { "api-key": "openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://my-resource.services.ai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2025-01-01",
        }),
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

      expect(postMultipartRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/edits?api-version=2024-12-01-preview",
          body: expect.any(FormData),
        }),
      );
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

      const editCallArgs = postMultipartRequestMock.mock.calls[0]?.[0] as {
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
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

      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://myresource.openai.azure.com/openai/deployments/gpt-image-2/images/generations?api-version=2024-12-01-preview",
        }),
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

      expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { Authorization: "Bearer openai-key" },
        }),
      );
      expect(postJsonRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.openai.com/v1/images/generations",
        }),
      );
    });
  });
});
