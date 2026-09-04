// Image runtime tests cover model-backed image routing, auth/profile handling,
// provider payload transforms, and MiniMax/Copilot special paths.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY_FIELD = ["api", "Key"].join("") as "apiKey";
const REQUIRE_API_KEY_FIELD = ["require", "ApiKey"].join("");
const SET_RUNTIME_API_KEY_FIELD = ["setRuntime", "ApiKey"].join("");

const hoisted = vi.hoisted(() => ({
  completeMock: vi.fn(),
  ensureOpenClawModelsJsonMock: vi.fn(async () => {}),
  getApiKeyForModelMock: vi.fn(
    async (): Promise<{
      apiKey: string;
      source: string;
      mode: string;
      profileId?: string;
    }> => ({
      [API_KEY_FIELD]: "test-token",
      source: "test",
      mode: "oauth",
    }),
  ),
  resolveApiKeyForProviderCoreMock: vi.fn(async () => ({
    [API_KEY_FIELD]: "test-token",
    source: "test",
    mode: "oauth",
  })),
  requireApiKeyMock: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
  setRuntimeApiKeyMock: vi.fn(),
  discoverModelsMock: vi.fn(),
  fetchMock: vi.fn(),
  registerProviderStreamForModelMock: vi.fn(),
  prepareProviderDynamicModelMock: vi.fn(async () => {}),
  prepareProviderRuntimeAuthMock: vi.fn(),
  acquireAgentRunPreparedModelRuntimeMock: vi.fn(),
  releasePreparedModelRuntimeMock: vi.fn(),
  resolveModelAsyncMock: vi.fn(),
  resolveModelWithRegistryMock: vi.fn(),
  shouldPreferProviderRuntimeResolvedModelMock: vi.fn(() => false),
  unwrapSecretSentinelsForProviderEgressMock: vi.fn((value: string) => value),
}));
const {
  completeMock,
  ensureOpenClawModelsJsonMock,
  getApiKeyForModelMock,
  resolveApiKeyForProviderCoreMock,
  requireApiKeyMock,
  setRuntimeApiKeyMock,
  discoverModelsMock,
  fetchMock,
  registerProviderStreamForModelMock,
  prepareProviderDynamicModelMock,
  prepareProviderRuntimeAuthMock,
  acquireAgentRunPreparedModelRuntimeMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  resolveModelWithRegistryMock,
  shouldPreferProviderRuntimeResolvedModelMock,
  unwrapSecretSentinelsForProviderEgressMock,
} = hoisted;
const preparedAuthStorage = { [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock };

type ResolveModelWithRegistryTestParams = {
  modelRegistry: { find: (provider: string, modelId: string) => unknown };
  provider: string;
  modelId: string;
};

vi.mock("../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
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
  applySecretRefHeaderSentinels: (model: unknown) => model,
  getApiKeyForModelCore: getApiKeyForModelMock,
  resolveApiKeyForProviderCore: resolveApiKeyForProviderCoreMock,
  [REQUIRE_API_KEY_FIELD]: requireApiKeyMock,
}));

vi.mock("../agents/provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

vi.mock("../agents/sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: () => ({ apiRegistry: {}, llmRuntime: {} }),
}));

vi.mock("../agents/provider-secret-egress.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/provider-secret-egress.js")>(
    "../agents/provider-secret-egress.js",
  )),
  unwrapSecretSentinelsForProviderEgress: unwrapSecretSentinelsForProviderEgressMock,
}));

vi.mock("../agents/agent-model-discovery.js", () => ({
  discoverAuthStorage: () => ({
    [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
  }),
  discoverModels: discoverModelsMock,
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: acquireAgentRunPreparedModelRuntimeMock,
}));

vi.mock("../plugins/provider-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  )),
  prepareProviderDynamicModel: prepareProviderDynamicModelMock,
  shouldPreferProviderRuntimeResolvedModel: shouldPreferProviderRuntimeResolvedModelMock,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: prepareProviderRuntimeAuthMock,
}));

vi.mock("../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync: resolveModelAsyncMock,
}));

const imageTestFetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("../infra/net/fetch-guard.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...mod,
    fetchWithSsrFGuard: imageTestFetchWithSsrFGuardMock,
  };
});

const { describeImageWithModelCore } = await import("./image.js");

describe("describeImageWithModelCore", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Provider endpoint policy comes from manifests. Pin source manifests so a
    // prior local build cannot make this source-checkout test read partial dist output.
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    vi.stubGlobal("fetch", fetchMock);
    vi.clearAllMocks();
    acquireAgentRunPreparedModelRuntimeMock.mockImplementation(
      async (input: { agentDir: string; config: object; workspaceDir?: string }) => ({
        snapshot: {
          agentDir: input.agentDir,
          config: input.config,
          workspaceDir: input.workspaceDir,
          createStores: () => ({
            authStorage: preparedAuthStorage,
            modelRegistry: {},
          }),
        },
        release: releasePreparedModelRuntimeMock,
      }),
    );
    fetchMock.mockImplementation(async () =>
      Response.json({
        base_resp: { status_code: 0 },
        content: "portal ok",
      }),
    );
    // Bridge fetchWithSsrFGuard through the globally-stubbed fetch so existing
    // assertions on fetchMock call count and arguments continue to work.
    imageTestFetchWithSsrFGuardMock.mockImplementation(
      async (opts: { url: string; init: RequestInit; timeoutMs?: number }) => {
        const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
        const init = { ...opts.init, signal };
        const response = await globalThis.fetch(opts.url, init);
        return { response, release: vi.fn(), finalUrl: opts.url };
      },
    );
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
          [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
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
    prepareProviderRuntimeAuthMock.mockImplementation(async (params: { provider: string }) => {
      return params.provider === "github-copilot"
        ? {
            [API_KEY_FIELD]: "test-token",
            baseUrl: "https://api.githubcopilot.com",
            request: {
              headers: {
                "Copilot-Integration-Id": "copilot-developer-cli",
                "Openai-Organization": "github-copilot",
              },
            },
          }
        : undefined;
    });
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
      describeImageWithModelCore({
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
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModelCore({
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
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(completeMock).toHaveBeenCalledOnce();
    const firstCall = expectDefined(completeMock.mock.calls[0], "image completion call 0");
    const [completionModel, context, options] = firstCall;
    expect(completionModel).toEqual({
      provider: "openai",
      id: "gpt-5.4",
      input: ["text", "image"],
      baseUrl: "https://chatgpt.com/backend-api",
    });
    expect(context.systemPrompt).toBe("Describe the image.");
    expect(context.messages).toHaveLength(1);
    expect(Object.keys(options).toSorted()).toEqual(["apiKey", "maxTokens", "signal", "timeoutMs"]);
    expect(options.apiKey).toBe("test-token");
    expect(options.maxTokens).toBe(4096);
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

  it("clamps oversized image description timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        provider: "openai",
        id: "gpt-5.4",
        input: ["text", "image"],
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "codex ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({
      text: "codex ok",
      model: "gpt-5.4",
    });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    const firstCall = expectDefined(completeMock.mock.calls[0], "image completion call 0");
    expect(firstCall[2].timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
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

    const result = await describeImageWithModelCore({
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
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "OpenRouter image completion call 0",
    );
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

  it("places DashScope image prompts in user content before images", async () => {
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-completions",
        provider: "qwen",
        id: "qwen3.6-plus",
        input: ["text", "image"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })),
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      api: "openai-completions",
      provider: "qwen",
      model: "qwen3.6-plus",
      stopReason: "stop",
      timestamp: Date.now(),
      content: [{ type: "text", text: "dashscope ok" }],
    });

    const result = await describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "qwen",
      model: "qwen3.6-plus",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      text: "dashscope ok",
      model: "qwen3.6-plus",
    });
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "DashScope image completion call 0",
    );
    const [, context] = firstCall;
    expect(context.systemPrompt).toBeUndefined();
    const userMessage = context.messages[0];
    if (!userMessage) {
      throw new Error("expected DashScope image completion user message");
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

      const result = await describeImageWithModelCore({
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
      const retryCall = expectDefined(completeMock.mock.calls[1], "retry image completion call 1");
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

  it("does not start the reasoning-only retry after caller cancellation", async () => {
    const controller = new AbortController();
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    completeMock.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled image description"));
      return {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4-mini",
        stopReason: "stop",
        timestamp: Date.now(),
        content: [{ type: "thinking", thinking: "internal", thinkingSignature: "reasoning" }],
      };
    });

    await expect(
      describeImageWithModelCore({
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
        provider: "openai",
        model: "gpt-5.4-mini",
        buffer: Buffer.from("png-bytes"),
        fileName: "image.png",
        mime: "image/png",
        prompt: "Describe the image.",
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller cancelled image description");

    expect(completeMock).toHaveBeenCalledOnce();
    const options = expectDefined(
      completeMock.mock.calls[0],
      "cancelled image completion call 0",
    )[2];
    expect(options?.signal?.aborted).toBe(true);
  });

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

    const result = describeImageWithModelCore({
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

    const assertion = expect(result).rejects.toThrow(
      "image description request timed out after 25ms",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    const firstCall = expectDefined(completeMock.mock.calls[0], "timed image completion call 0");
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.signal.aborted).toBe(true);
    expect(options.timeoutMs).toBe(25);
  });

  it("releases the prepared runtime when a provider ignores caller cancellation", async () => {
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
    const controller = new AbortController();
    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    const assertion = expect(result).rejects.toThrow("caller cancelled provider request");
    controller.abort(new Error("caller cancelled provider request"));
    await assertion;

    expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce();
  });

  it("keeps the full configured timeout for provider requests after slow setup", async () => {
    vi.useFakeTimers();
    const slowSetupMs = 400;
    discoverModelsMock.mockReturnValue({
      find: vi.fn(() => ({
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        baseUrl: "https://api.openai.com/v1",
      })),
    });
    resolveModelAsyncMock.mockImplementationOnce(
      async (provider: string, modelId: string, agentDir?: string, cfg?: unknown) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, slowSetupMs);
        });
        const authStorage = {
          [SET_RUNTIME_API_KEY_FIELD]: setRuntimeApiKeyMock,
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
    completeMock.mockImplementation(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(slowSetupMs);
    await Promise.resolve();
    expect(completeMock).toHaveBeenCalledTimes(1);
    const firstCall = expectDefined(
      completeMock.mock.calls[0],
      "slow setup image completion call 0",
    );
    const options = firstCall[2];
    if (!options?.signal) {
      throw new Error("Expected image completion abort signal");
    }
    expect(options.timeoutMs).toBe(1000);

    const assertion = expect(result).rejects.toThrow(
      `image description request timed out after 1000ms (setup took ${slowSetupMs}ms before provider request started)`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(options.signal.aborted).toBe(true);
  });

  it("rejects when image runtime setup exceeds the request timeout", async () => {
    vi.useFakeTimers();
    resolveModelAsyncMock.mockImplementationOnce(() => new Promise(() => {}));

    const result = describeImageWithModelCore({
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

    const assertion = expect(result).rejects.toThrow(
      "image description setup timed out after 25ms before provider request started",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("releases a prepared generation that resolves after the setup timeout", async () => {
    vi.useFakeTimers();
    let finishResolution!: (value: {
      authStorage: typeof preparedAuthStorage;
      model: { provider: string; id: string; api: string; input: string[] };
      modelRegistry: object;
    }) => void;
    resolveModelAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = resolve;
        }),
    );

    const result = describeImageWithModelCore({
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
    const assertion = expect(result).rejects.toThrow(
      "image description setup timed out after 25ms before provider request started",
    );
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    finishResolution({
      authStorage: preparedAuthStorage,
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
        api: "openai-responses",
        input: ["text", "image"],
      },
      modelRegistry: {},
    });
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce());
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("releases a prepared generation when cancellation wins during setup", async () => {
    let finishResolution!: (value: {
      authStorage: typeof preparedAuthStorage;
      model: { provider: string; id: string; api: string; input: string[] };
      modelRegistry: object;
    }) => void;
    resolveModelAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResolution = resolve;
        }),
    );
    const controller = new AbortController();
    const result = describeImageWithModelCore({
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
      provider: "openai",
      model: "gpt-5.4-mini",
      buffer: Buffer.from("png-bytes"),
      fileName: "image.png",
      mime: "image/png",
      prompt: "Describe the image.",
      timeoutMs: 1000,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(resolveModelAsyncMock).toHaveBeenCalledOnce());
    const assertion = expect(result).rejects.toThrow("caller cancelled during setup");
    controller.abort(new Error("caller cancelled during setup"));
    await assertion;
    expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();

    finishResolution({
      authStorage: preparedAuthStorage,
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
        api: "openai-responses",
        input: ["text", "image"],
      },
      modelRegistry: {},
    });

    await vi.waitFor(() => expect(releasePreparedModelRuntimeMock).toHaveBeenCalledOnce());
    expect(completeMock).not.toHaveBeenCalled();
  });
});
