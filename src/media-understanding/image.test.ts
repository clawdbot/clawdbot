import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn(async () => ({
    apiKey: "oauth-test", // pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  resolveApiKeyForProviderMock: vi.fn(async () => ({
    apiKey: "oauth-test", // pragma: allowlist secret
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  fetchMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
  prepareProviderDynamicModelMock: vi.fn(async () => {}),
  resolveModelWithRegistryMock: vi.fn(),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  registerProviderStreamForModelMock,
  prepareProviderDynamicModelMock,
  resolveModelWithRegistryMock,
} = hoisted;

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../agents/models-config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/models-config.js")>(
    "../agents/models-config.js",
  )),
  ensureOpenClawModelsJson: ensureOpenClawModelsJsonMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  getApiKeyForModel: getApiKeyForModelMock,
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  requireApiKey: requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

vi.mock("../agents/pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: () => ({
    setRuntimeApiKey: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  prepareProviderDynamicModel: prepareProviderDynamicModelMock,
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModelWithRegistry: resolveModelWithRegistryMock,
}));

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => ({
        base_resp: { status_code: 0 },
        content: "portal ok",
      })),
      text: vi.fn(async () => ""),
    });
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "MiniMax-VL-01",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    resolveModelWithRegistryMock.mockImplementation(
      // Delegate to modelRegistry.find so tests that override discoverModelsMock
      // automatically get the right model through resolveModelWithRegistry.
      ({ modelRegistry, provider, modelId }: ResolveModelWithRegistryTestParams) =>
        modelRegistry.find(provider, modelId),
    );
  });

  it("routes minimax-portal image models through the MiniMax VLM endpoint", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const authStore = { version: 1, profiles: {} };
    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "MiniMax-VL-01",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      authStore,
    });

    expect(result).toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });
    expect(ensureOpenClawModelsJsonMock).toHaveBeenCalled();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ store: authStore }),
    );
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.minimax.io/v1/coding_plan/vlm",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer oauth-test",
          "Content-Type": "application/json",
          "MM-API-Source": "OpenClaw",
        },
        body: JSON.stringify({
          prompt: "Describe the image.",
          image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(timeoutSpy).toHaveBeenCalledWith(1000);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses generic completion for non-canonical minimax-portal image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "minimax-portal",
      model: "custom-vision",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "generic ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "minimax-portal",
      model: "custom-vision",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "generic ok",
      model: "custom-vision",
    });
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          provider: "minimax-portal",
          id: "custom-vision",
        }),
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    );
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves configured image models when discovery has not registered the provider", async () => {
    const registryFind = vi.fn(() => null);
    discoverModelsMock.mockReturnValue({ find: registryFind });
    resolveModelWithRegistryMock.mockImplementationOnce(
      ({ provider, modelId }: ResolveModelWithRegistryTestParams) => ({
        provider,
        id: modelId,
        api: "anthropic-messages",
        input: ["text", "image"],
        baseUrl: "http://127.0.0.1:1234",
      }),
    );
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "anthropic-messages",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "local vision ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {
        models: {
          providers: {
            lmstudio: {
              api: "anthropic-messages",
              baseUrl: "http://127.0.0.1:1234",
              models: [
                {
                  id: "google/gemma-4-e2b",
                  name: "google/gemma-4-e2b",
                  input: ["text", "image"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131_072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      provider: "lmstudio",
      model: "google/gemma-4-e2b",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "local vision ok",
      model: "google/gemma-4-e2b",
    });
    expect(registryFind).not.toHaveBeenCalled();
    expect(resolveModelWithRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "lmstudio",
        modelId: "google/gemma-4-e2b",
        cfg: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              lmstudio: expect.objectContaining({
                baseUrl: "http://127.0.0.1:1234",
              }),
            }),
          }),
        }),
      }),
    );
    expect(prepareProviderDynamicModelMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it("passes image prompt as system instructions for codex image requests", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai-codex",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai-codex",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
      }),
      expect.objectContaining({
        systemPrompt: "Describe the image.",
        messages: [
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                type: "image",
                mimeType: "image/png",
              }),
            ],
          }),
        ],
      }),
      expect.any(Object),
    );
    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.messages?.[0]?.content).toHaveLength(1);
  });

  it("places OpenRouter image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "openrouter",
        id: "google/gemini-2.5-flash",
        input: ["text", "image"],
        baseUrl: "https://openrouter.ai/api/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "openrouter ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "openrouter ok",
      model: "google/gemini-2.5-flash",
    });
    const [, context] = completeMock.mock.calls[0] ?? [];
    expect(context?.systemPrompt).toBeUndefined();
    expect(context?.messages?.[0]?.content).toEqual([
      { type: "text", text: "Describe the image." },
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
      }),
    ]);
  });

  it.each([
    {
      name: "direct OpenAI Responses baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "default OpenAI Responses route without explicit baseUrl",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "azure-openai provider using openai-responses api",
      provider: "azure-openai",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      },
      expectedRetryPayload: {
        reasoning: { effort: "none" },
      },
    },
    {
      name: "proxy-like openai-responses route",
      provider: "openai",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://proxy.example.com/v1",
      },
      expectedRetryPayload: {},
    },
  ])(
    "retries reasoning-only image responses with reasoning disabled for $name",
    async ({ provider, model, expectedRetryPayload }) => {
      discoverModelsMock.mockReturnValue({
        find: vi.fn(() => model),
      });
      completeMock
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "thinking",
              thinking: "internal image reasoning",
              thinkingSignature: "reasoning_content",
            },
          ],
        })
        .mockResolvedValueOnce({
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          content: [{ type: "text", text: "retry ok" }],
        });

      const result = await describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider,
        model: model.id,
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      });

      expect(result).toEqual({
        text: "retry ok",
        model: model.id,
      });
      expect(completeMock).toHaveBeenCalledTimes(2);
      const [, , retryOptions] = completeMock.mock.calls[1] ?? [];
      expect(retryOptions?.onPayload).toEqual(expect.any(Function));
      const retryPayload = await retryOptions?.onPayload?.(
        {
          reasoning: { effort: "high", summary: "auto" },
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
        },
        completeMock.mock.calls[1]?.[0],
      );
      expect(retryPayload).toEqual(expectedRetryPayload);
    },
  );

  it("normalizes deprecated google flash ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3-flash-preview");
      return {
        provider: "google",
        id: "gemini-3-flash-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3-flash-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash ok",
      model: "gemini-3-flash-preview",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("normalizes gemini 3.1 flash-lite ids before lookup and keeps profile auth selection", async () => {
    const findMock = vi.fn((provider: string, modelId: string) => {
      expect(provider).toBe("google");
      expect(modelId).toBe("gemini-3.1-flash-lite-preview");
      return {
        provider: "google",
        id: "gemini-3.1-flash-lite-preview",
        input: ["text", "image"],
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    });
    discoverModelsMock.mockReturnValue({ find: findMock });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "flash lite ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "google",
      model: "gemini-3.1-flash-lite",
      profile: "google:default",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "flash lite ok",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(findMock).toHaveBeenCalledOnce();
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "google:default",
      }),
    );
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });
});
