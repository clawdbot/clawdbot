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
  resolveModelAsyncMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
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
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  resolveCopilotApiTokenMock,
} = hoisted;

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

type AuthRequestCall = {
  profileId?: string;
  store?: unknown;
};

function requireMockCallAt<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  index: number,
  label: string,
): Calls[number] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label} call ${index}`);
  }
  return call as Calls[number];
}

function requireFirstMockCall<const Calls extends readonly unknown[][]>(
  mock: { mock: { calls: Calls } },
  label: string,
): Calls[number] {
  return requireMockCallAt(mock, 0, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

vi.mock("@earendil-works/pi-ai", async () => {
  const actual =
    await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
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
  resolveModelAsync: resolveModelAsyncMock,
}));

vi.mock("../plugin-sdk/provider-auth.js", () => ({
  buildCopilotIdeHeaders: () => ({
    "Editor-Version": "vscode/1.107.0",
    "User-Agent": "GitHubCopilotChat/0.35.0",
  }),
  COPILOT_INTEGRATION_ID: "vscode-chat",
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}));

const { describeImageWithModel } = await import("./image.js");

describe("describeImageWithModel", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    resolveModelAsyncMock.mockImplementation(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        const authStorage = {
          setRuntimeApiKey: setRuntimeApiKeyMock,
        };
        const modelRegistry = discoverModelsMock(authStorage, agentDir);
        const model = resolveModelWithRegistryMock({
          provider,
          modelId,
          modelRegistry,
          cfg,
          agentDir,
        });
        return { authStorage, model, modelRegistry };
      },
    );
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: "copilot-api-token",
      expiresAt: Date.now() + 60_000,
      source: "test",
      baseUrl: "https://api.githubcopilot.com",
    });
  });

  function getApiKeyForModelCall(index = 0): AuthRequestCall {
    const call = (getApiKeyForModelMock.mock.calls as unknown[][]).at(index);
    if (!call) {
      throw new Error(`Expected getApiKeyForModel call ${index}`);
    }
    return call[0] as AuthRequestCall;
  }

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
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.store).toBe(authStore);
    expect(requireApiKeyMock).toHaveBeenCalled();
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("minimax-portal", "oauth-test");
    const [fetchUrl, fetchOptionsValue] = requireFirstMockCall(fetchMock, "fetch");
    const fetchOptions = requireRecord(fetchOptionsValue, "fetch options");
    expect(fetchUrl).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(fetchOptions).toEqual({
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
      signal: fetchOptions.signal,
    });
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
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
    const [streamRequest] = requireFirstMockCall(
      registerProviderStreamForModelMock,
      "provider stream registration",
    );
    expect(streamRequest).toEqual({
      model: {
        provider: "minimax-portal",
        id: "custom-vision",
        input: ["text", "image"],
        baseUrl: "https://api.minimax.io/anthropic",
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes workspaceDir through MiniMax VLM fallback auth", async () => {
    const authStorage = {
      setRuntimeApiKey: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock.mockResolvedValue({
      authStorage,
      modelRegistry: { find: vi.fn(() => null) },
      error: "Unknown model: minimax-portal/MiniMax-VL-01",
    });

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({
      text: "portal ok",
      model: "MiniMax-VL-01",
    });

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "minimax-portal",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("carries workspaceDir through image model and stream resolution", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "google-generative-ai",
      provider: "google",
      model: "gemini-2.5-flash",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "workspace ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "google",
      model: "gemini-2.5-flash",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result.text).toBe("workspace ok");
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "google",
      "gemini-2.5-flash",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        skipPiDiscovery: true,
        skipProviderRuntimeHooks: true,
        workspaceDir: "/tmp/openclaw-workspace",
      },
    );
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: {
        provider: "google",
        id: "gemini-2.5-flash",
        api: "google-generative-ai",
        input: ["text", "image"],
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("applies provider normalization before using a fast image model match", async () => {
    const authStorage = {
      setRuntimeApiKey: setRuntimeApiKeyMock,
    };
    resolveModelAsyncMock
      .mockResolvedValueOnce({
        authStorage,
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-completions",
          input: ["text", "image"],
        },
      })
      .mockResolvedValueOnce({
        authStorage,
        model: {
          provider: "openai",
          id: "gpt-5.4",
          api: "openai-responses",
          input: ["text", "image"],
        },
      });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "normalized ok" }],
    });

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "normalized ok",
      model: "gpt-5.4",
    });
    expect(ensureOpenClawModelsJsonMock).not.toHaveBeenCalled();
    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      1,
      "openai",
      "gpt-5.4",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        skipPiDiscovery: true,
        skipProviderRuntimeHooks: true,
      },
    );
    expect(resolveModelAsyncMock).toHaveBeenNthCalledWith(
      2,
      "openai",
      "gpt-5.4",
      "/tmp/openclaw-agent",
      {},
      {
        allowBundledStaticCatalogFallback: true,
        skipPiDiscovery: true,
      },
    );
    const [completeModel] = requireFirstMockCall(completeMock, "complete");
    expect(requireRecord(completeModel, "complete model").api).toBe("openai-responses");
  });

  it("uses plugin stream hooks when available for image models", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      })),
    });
    const streamResult = {
      result: vi.fn(async () => ({
        role: "assistant",
        api: "ollama",
        provider: "ollama",
        model: "llava:latest",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "text", text: "plugin vision ok" }],
      })),
    };
    const streamFn = vi.fn(() => streamResult);
    registerProviderStreamForModelMock.mockReturnValueOnce(streamFn);

    const result = await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "ollama",
      model: "llava:latest",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "plugin vision ok",
      model: "llava:latest",
    });
    expect(registerProviderStreamForModelMock).toHaveBeenCalledWith({
      model: {
        provider: "ollama",
        id: "llava:latest",
        api: "ollama",
        input: ["text", "image"],
      },
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("resolves configured image models when discovery has not registered the provider", async () => {
    const registryFind = vi.fn(() => null);
    discoverModelsMock.mockReturnValue({ find: registryFind });
    resolveModelWithRegistryMock.mockImplementation(
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
    const [resolveRequestValue] = requireFirstMockCall(
      resolveModelWithRegistryMock,
      "model registry resolution",
    );
    const resolveRequest = requireRecord(resolveRequestValue, "model registry request");
    expect(resolveRequest.provider).toBe("lmstudio");
    expect(resolveRequest.modelId).toBe("google/gemma-4-e2b");
    expect(resolveRequest.agentDir).toBe("/tmp/openclaw-agent");
    expect(
      requireRecord(
        requireRecord(
          requireRecord(requireRecord(resolveRequest.cfg, "request config").models, "models")
            .providers,
          "model providers",
        ).lmstudio,
        "lmstudio provider",
      ).baseUrl,
    ).toBe("http://127.0.0.1:1234");
    expect(prepareProviderDynamicModelMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledOnce();
  });

  it("reports the resolved model input when an image model is text-only", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "lmstudio",
        id: "text-only",
        api: "openai-completions",
        input: ["text"],
        baseUrl: "http://127.0.0.1:1234",
      })),
    });

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "lmstudio",
        model: "text-only",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      "Model does not support images: lmstudio/text-only (resolved lmstudio/text-only input: text)",
    );
    expect(completeMock).not.toHaveBeenCalled();
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
    const firstCall = requireFirstMockCall(completeMock, "image completion");
    const [completionModel, context, options] = firstCall;
    expect(completionModel).toEqual({
      provider: "openai-codex",
      id: "gpt-5.4",
      input: ["text", "image"],
      baseUrl: "https://chatgpt.com/backend-api",
    });
    expect(context.systemPrompt).toBe("Describe the image.");
    expect(context.messages).toHaveLength(1);
    expect(Object.keys(options).toSorted()).toEqual(["apiKey", "maxTokens", "signal", "timeoutMs"]);
    expect(options.apiKey).toBe("oauth-test");
    expect(options.maxTokens).toBe(512);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(1000);
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected image completion user message");
    }
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toHaveLength(1);
    expect(userMessage.content[0]).toEqual({
      type: "image",
      data: Buffer.from("png-bytes").toString("base64"),
      mimeType: "image/png",
    });
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
    const firstCall = requireFirstMockCall(completeMock, "OpenRouter image completion");
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected OpenRouter image completion user message");
    }
    expect(userMessage.content).toEqual([
      { type: "text", text: "Describe the image." },
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
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
      const retryCall = requireMockCallAt(completeMock, 1, "retry image completion");
      const [retryModel, , retryOptions] = retryCall;
      if (!retryOptions?.onPayload) {
        throw new Error("expected retry payload mapper");
      }
      const retryPayload = await retryOptions.onPayload(
        {
          reasoning: { effort: "high", summary: "auto" },
          reasoning_effort: "high",
          include: ["reasoning.encrypted_content"],
        },
        retryModel,
      );
      expect(retryPayload).toEqual(expectedRetryPayload);
    },
  );

  it("rejects when a generic image completion ignores the abort signal", async () => {
    vi.useFakeTimers();
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow("image description timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const firstCall = requireFirstMockCall(completeMock, "timed image completion");
    const [, , options] = firstCall;
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.signal.aborted).toBe(true);
    expect(options.timeoutMs).toBe(25);
  });

  it("rejects when image runtime setup exceeds the request timeout", async () => {
    vi.useFakeTimers();
    resolveModelAsyncMock.mockImplementationOnce(() => new Promise(() => {}));

    const result = describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 25,
    });

    const assertion = expect(result).rejects.toThrow("image description timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(completeMock).not.toHaveBeenCalled();
  });

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
    expect(findMock).toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
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
    expect(findMock).toHaveBeenCalled();
    const authRequest = getApiKeyForModelCall();
    expect(authRequest?.profileId).toBe("google:default");
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("google", "oauth-test");
  });

  it("places image prompt in user content for github-copilot provider", async () => {
    const providerStreamResult = {
      role: "assistant",
      api: "openai-completions",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    };
    const providerStreamFn = vi.fn(() => ({
      result: vi.fn(async () => providerStreamResult),
    }));
    registerProviderStreamForModelMock.mockReturnValueOnce(providerStreamFn);
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://stale.example.test",
      })),
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "github-copilot",
      model: "gemini-3.1-pro-preview",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).not.toHaveBeenCalled();
    expect(providerStreamFn).toHaveBeenCalledOnce();
    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith({
      githubToken: "oauth-test",
    });
    expect(setRuntimeApiKeyMock).toHaveBeenCalledWith("github-copilot", "copilot-api-token");
    const [completionModel, context, options] = providerStreamFn.mock.calls[0] as unknown as [
      { baseUrl?: string },
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
      { apiKey?: string; headers?: Record<string, string> },
    ];
    expect(completionModel.baseUrl).toBe("https://api.githubcopilot.com");
    expect(options.apiKey).toBe("copilot-api-token");
    expect(options.headers).toMatchObject({
      "Copilot-Integration-Id": "vscode-chat",
      "Copilot-Vision-Request": "true",
      "Editor-Version": "vscode/1.107.0",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    });
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).toContain("text");
    expect(contentTypes).toContain("image");
  });

  it("fails github-copilot image runtime setup when token exchange fails", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        api: "openai-completions",
        baseUrl: "https://api.githubcopilot.com",
      })),
    });
    resolveCopilotApiTokenMock.mockRejectedValueOnce(
      new Error("Copilot token exchange failed: HTTP 401"),
    );

    await expect(
      describeImageWithModel({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "github-copilot",
        model: "gemini-3.1-pro-preview",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("Copilot token exchange failed: HTTP 401");

    expect(setRuntimeApiKeyMock).not.toHaveBeenCalledWith("github-copilot", "oauth-test");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not place image prompt in user content for non-copilot providers", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-4o",
        input: ["text", "image"],
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "A solid red square." }],
    });

    await describeImageWithModel({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-4o",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(completeMock).toHaveBeenCalledOnce();
    const [, context] = completeMock.mock.calls[0] as [
      unknown,
      { systemPrompt?: string; messages?: Array<{ role: string; content: unknown[] }> },
    ];
    // Non-Copilot providers keep prompt in system message, images in user message
    expect(context.systemPrompt).toBe("Describe the image.");
    const userMessage = context.messages?.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const contentTypes = userMessage!.content.map((block) => (block as { type: string }).type);
    expect(contentTypes).not.toContain("text");
    expect(contentTypes).toContain("image");
  });
});
