import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAICodexImageGenerationProvider,
  buildOpenAIImageGenerationProvider,
} from "./image-generation-provider.js";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  assertOkOrThrowHttpErrorMock,
  resolveProviderHttpRequestConfigMock,
} = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "openai-key" })),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  resolveProviderHttpRequestConfigMock: vi.fn((params) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: Boolean(params.allowPrivateNetwork),
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: assertOkOrThrowHttpErrorMock,
  postJsonRequest: postJsonRequestMock,
  postMultipartRequest: postMultipartRequestMock,
  resolveProviderHttpRequestConfig: resolveProviderHttpRequestConfigMock,
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

describe("openai image generation provider", () => {
  afterEach(() => {
    resolveApiKeyForProviderMock.mockClear();
    postJsonRequestMock.mockReset();
    postMultipartRequestMock.mockReset();
    assertOkOrThrowHttpErrorMock.mockClear();
    resolveProviderHttpRequestConfigMock.mockClear();
    vi.unstubAllEnvs();
  });

  it("advertises the current OpenAI image model and 2K/4K size hints", () => {
    const provider = buildOpenAIImageGenerationProvider();

    expect(provider.defaultModel).toBe("gpt-image-2");
    expect(provider.models).toEqual(["gpt-image-2"]);
    expect(provider.capabilities.geometry?.sizes).toEqual(
      expect.arrayContaining(["2048x2048", "3840x2160", "2160x3840"]),
    );
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

  it("registers Codex OAuth image generation through Responses streaming", async () => {
    mockCodexImageStream({ imageData: "codex-image", revisedPrompt: "revised codex prompt" });

    const provider = buildOpenAICodexImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai-codex",
      model: "gpt-image-2",
      prompt: "Draw a Codex lighthouse",
      cfg: {},
      authStore,
      count: 1,
      size: "1024x1536",
    });

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
          Authorization: "Bearer openai-key",
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
        body: expect.objectContaining({
          model: "gpt-5.4",
          instructions: "You are an image generation assistant.",
          stream: true,
          store: false,
          tools: [
            {
              type: "image_generation",
              model: "gpt-image-2",
              size: "1024x1536",
            },
          ],
          tool_choice: { type: "image_generation" },
        }),
      }),
    );
    expect(postMultipartRequestMock).not.toHaveBeenCalled();
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("codex-image"),
        mimeType: "image/png",
        fileName: "image-1.png",
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

  it("sends Codex reference images as Responses input images", async () => {
    mockCodexImageStream();

    const provider = buildOpenAICodexImageGenerationProvider();
    await provider.generateImage({
      provider: "openai-codex",
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
    mockCodexImageStream({ imageData: "codex-image" });

    const provider = buildOpenAICodexImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "openai-codex",
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
