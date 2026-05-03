import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../model-suppression.js", () => {
  // Mirrors the canonical manifest-driven suppression in
  // extensions/qwen/openclaw.plugin.json and src/plugins/manifest-model-suppression.ts.
  function isQwenCodingPlanBaseUrl(value: string | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
      return (
        hostname === "coding.dashscope.aliyuncs.com" ||
        hostname === "coding-intl.dashscope.aliyuncs.com"
      );
    } catch {
      return false;
    }
  }

  function resolveConfiguredQwenBaseUrl(config: unknown): string | undefined {
    const providers = (config as { models?: { providers?: Record<string, { baseUrl?: string }> } })
      ?.models?.providers;
    if (!providers) {
      return undefined;
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const normalizedProvider = provider.trim().toLowerCase();
      if (normalizedProvider !== "qwen" && normalizedProvider !== "modelstudio") {
        continue;
      }
      const baseUrl = entry?.baseUrl?.trim();
      if (baseUrl) {
        return baseUrl;
      }
    }
    return undefined;
  }

  return {
    shouldSuppressBuiltInModel: ({
      provider,
      id,
      baseUrl,
      config,
    }: {
      provider?: string;
      id?: string;
      baseUrl?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "openai" ||
          provider === "azure-openai-responses" ||
          provider === "openai-codex") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(baseUrl ?? resolveConfiguredQwenBaseUrl(config))
      );
    },
    shouldUnconditionallySuppress: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" ||
          provider === "azure-openai-responses" ||
          provider === "openai-codex") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return false;
    },
    buildSuppressedBuiltInModelError: ({
      provider,
      id,
      config,
    }: {
      provider?: string;
      id?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(resolveConfiguredQwenBaseUrl(config))
      ) {
        return "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.";
      }
      if (
        (provider === "openai" ||
          provider === "azure-openai-responses" ||
          provider === "openai-codex") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.`;
      }
      return undefined;
    },
  };
});

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const mockGetOpenRouterModelCapabilities = vi.fn<
  (modelId: string) => OpenRouterModelCapabilities | undefined
>(() => undefined);
const mockLoadOpenRouterModelCapabilities = vi.fn<(modelId: string) => Promise<void>>(
  async () => {},
);
vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: (modelId: string) => mockGetOpenRouterModelCapabilities(modelId),
  loadOpenRouterModelCapabilities: (modelId: string) =>
    mockLoadOpenRouterModelCapabilities(modelId),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { buildForwardCompatTemplate } from "./model.forward-compat.test-support.js";
import { buildInlineProviderModels, resolveModel, resolveModelAsync } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  OPENAI_CODEX_TEMPLATE_MODEL,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels(discoverModels);
  vi.mocked(discoverModels).mockClear();
  vi.mocked(discoverAuthStorage).mockClear();
  mockGetOpenRouterModelCapabilities.mockReset();
  mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);
  mockLoadOpenRouterModelCapabilities.mockReset();
  mockLoadOpenRouterModelCapabilities.mockResolvedValue();
});

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: [
      "openrouter",
      "github-copilot",
      "openai-codex",
      "openai",
      "anthropic",
      "zai",
    ],
    getOpenRouterModelCapabilities: (modelId: string) =>
      mockGetOpenRouterModelCapabilities(modelId),
    loadOpenRouterModelCapabilities: async (modelId: string) => {
      await mockLoadOpenRouterModelCapabilities(modelId);
    },
  });
}

function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
) {
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModel(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    runtimeHooks: createRuntimeHooks(),
  });
}

function resolveModelAsyncForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: { retryTransientProviderRuntimeMiss?: boolean },
) {
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    ...options,
    runtimeHooks: createRuntimeHooks(),
  });
}

describe("resolveModel", () => {
  it("skips PI auth and model discovery during dynamic model resolution", async () => {
    const result = await resolveModelAsync(
      "openrouter",
      "openrouter/auto",
      "/tmp/agent",
      undefined,
      {
        runtimeHooks: createRuntimeHooks(),
        skipPiDiscovery: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/auto",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("defaults model input to text when discovery omits input", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "missing-input",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const result = resolveModelForTest("custom", "missing-input", "/tmp/agent", {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9999",
            api: "openai-completions",
            // Intentionally keep this minimal — the discovered model provides the rest.
            models: [{ id: "missing-input", name: "missing-input" }],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.model?.input)).toBe(true);
    expect(result.model?.input).toEqual(["text"]);
  });

  it("defaults missing model cost before handing models to PI", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("http://localhost:9000");
    expect(result.model?.provider).toBe("custom");
    expect(result.model?.id).toBe("missing-model");
    expect(result.model?.api).toBe("openai-completions");
  });

  it("defaults baseUrl-only local custom fallback models to chat completions", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "local-agent-proxy/gpt-5.2" },
        },
      },
      models: {
        providers: {
          "local-agent-proxy": {
            baseUrl: "http://127.0.0.1:3000/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("local-agent-proxy", "gpt-5.2", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "local-agent-proxy",
      id: "gpt-5.2",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
    });
    expect(getModelProviderRequestTransport(result.model ?? {})).toBeUndefined();
  });

  it("resolves explicitly configured qwen3.6-plus before Coding Plan built-in suppression", () => {
    const cfg = {
      models: {
        providers: {
          qwen: {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.6-plus",
                name: "qwen3.6-plus",
                input: ["text", "image"],
                reasoning: false,
                contextWindow: 1_000_000,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("qwen", "qwen3.6-plus", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "qwen",
      id: "qwen3.6-plus",
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
  });

  it("keeps unconfigured qwen3.6-plus suppressed on Coding Plan endpoints", () => {
    const cfg = {
      models: {
        providers: {
          qwen: {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("qwen", "qwen3.6-plus", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.",
    );
  });

  it("#74451: resolves explicitly configured openai-codex/gpt-5.4-mini inline entries", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            models: [
              {
                id: "gpt-5.4-mini",
                name: "GPT-5.4 mini",
                api: "openai-codex-responses",
                contextWindow: 400_000,
                maxTokens: 128_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.4-mini", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      api: "openai-codex-responses",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes Google fallback baseUrls for custom providers", () => {
    const cfg = {
      models: {
        providers: {
          "google-paid": {
            baseUrl: "https://generativelanguage.googleapis.com",
            api: "google-generative-ai",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google-paid", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes configured Google override baseUrls when provider api is omitted", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "google",
      modelId: "gemini-2.5-pro",
      templateModel: {
        ...makeModel("gemini-2.5-pro"),
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    });

    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google", "gemini-2.5-pro", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("google-generative-ai");
    expect(result.model?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes custom api.openai.com providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("gpt-5.4"),
                provider: "custom-openai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("normalizes custom api.x.ai providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-xai": {
            baseUrl: "https://api.x.ai/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("grok-4.1-fast"),
                provider: "custom-xai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-xai", "grok-4.1-fast", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "custom-xai",
      id: "grok-4.1-fast",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("includes provider headers in provider fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: { "X-Custom-Auth": "token-123" },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    // Requesting a non-listed model forces the providerCfg fallback branch.
    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops SecretRef marker provider headers in fallback models", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: {
              Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
              "X-Managed": "secretref-managed",
              "X-Custom-Auth": "token-123",
            },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "listed-model",
      templateModel: {
        ...makeModel("listed-model"),
        provider: "custom",
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
      },
    });

    const result = resolveModelForTest("custom", "listed-model", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("prefers matching configured model metadata for fallback token limits", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                contextWindow: 4096,
                maxTokens: 1024,
              },
              {
                ...makeModel("model-b"),
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.contextWindow).toBe(262144);
    expect(result.model?.maxTokens).toBe(32768);
  });

  it("merges configured model params with agent defaults for resolved models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3:32b",
      templateModel: {
        ...makeModel("qwen3:32b"),
        provider: "ollama",
        params: { num_ctx: 4096, keep_alive: "1m" },
      },
    });
    const cfg = {
      agents: {
        defaults: {
          models: {
            "OLLAMA/qwen3:32B": {
              params: { num_ctx: 8192, thinking: "low" },
            },
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [
              {
                ...makeModel("qwen3:32b"),
                params: { num_ctx: 16384 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3:32b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 16384,
      keep_alive: "1m",
      thinking: "low",
    });
  });

  it("resolves provider request timeout metadata for configured provider models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3:32b",
      templateModel: {
        ...makeModel("qwen3:32b"),
        provider: "ollama",
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            timeoutSeconds: 300,
            models: [makeModel("qwen3:32b")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3:32b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      300_000,
    );
  });

  it("uses provider-level context defaults over discovered metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      templateModel: {
        ...makeModel("qwen3.5:9b"),
        provider: "ollama",
        contextWindow: 216_000,
        contextTokens: 216_000,
        maxTokens: 65_536,
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            contextWindow: 8_192,
            contextTokens: 8_000,
            models: [{ id: "qwen3.5:9b", name: "qwen3.5:9b" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3.5:9b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(8_192);
    expect((result.model as { contextTokens?: number } | undefined)?.contextTokens).toBe(8_000);
    expect(result.model?.maxTokens).toBe(8_192);
  });

  it("keeps per-model context values above provider-level defaults", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      templateModel: {
        ...makeModel("qwen3.5:9b"),
        provider: "ollama",
        contextWindow: 216_000,
        maxTokens: 65_536,
      },
    });
    const cfg = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            contextWindow: 8_192,
            maxTokens: 4_096,
            models: [
              {
                id: "qwen3.5:9b",
                name: "qwen3.5:9b",
                contextWindow: 16_384,
                maxTokens: 12_000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "qwen3.5:9b", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(16_384);
    expect(result.model?.maxTokens).toBe(12_000);
  });

  it("applies agent default model params without explicit provider config", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "ollama",
      modelId: "llama3.2",
      templateModel: {
        ...makeModel("llama3.2"),
        provider: "ollama",
      },
    });
    const cfg = {
      agents: {
        defaults: {
          models: {
            "ollama/llama3.2": {
              params: { num_ctx: 32768 },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("ollama", "llama3.2", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 32768,
    });
  });

  it("propagates reasoning from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                reasoning: false,
              },
              {
                ...makeModel("model-b"),
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates image input capability from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text"],
              },
              {
                ...makeModel("model-b"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("propagates image input when configured model ids include the provider prefix", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("custom/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("matches provider-prefixed configured model ids through provider aliases", () => {
    const cfg = {
      models: {
        providers: {
          volcengine: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("volcengine/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("bytedance", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      id: "volcengine/vision-model",
      input: ["text", "image"],
    });
  });

  it("does not treat arbitrary namespaced model ids as provider prefixes", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("meta/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.model?.id).toBe("vision-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("resolves custom MLX-style Hugging Face ids without adding the provider prefix", () => {
    const modelId = "mlx-community/Qwen3-30B-A3B-6bit";
    const cfg = {
      agents: {
        defaults: {
          model: { primary: `mlx/${modelId}` },
        },
      },
      models: {
        providers: {
          mlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            apiKey: "mlx-local",
            api: "openai-completions",
            models: [
              {
                ...makeModel(modelId),
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("mlx", modelId, "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "mlx",
      id: modelId,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });

  it("prefers provider-prefixed configured metadata over discovered text-only models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "vision-model",
      templateModel: {
        ...makeModel("vision-model"),
        provider: "custom",
        input: ["text"],
      },
    });
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            api: "openai-completions",
            models: [
              {
                ...makeModel("custom/vision-model"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "vision-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "custom",
      id: "custom/vision-model",
      input: ["text", "image"],
    });
  });

  it("keeps unknown fallback models text-only instead of borrowing image input from another configured model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "typoed-model", "/tmp/agent", cfg);

    expect(result.model?.id).toBe("typoed-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("repairs stale text-only Foundry fallback rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                name: "gpt-5.4",
                api: "azure-openai-responses",
                input: ["text"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "microsoft-foundry",
      modelId: "gpt-5.4",
      templateModel: {
        id: "gpt-5.4",
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        api: "azure-openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent");

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("matches prefixed OpenRouter native ids in configured fallback models", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("openrouter/healer-alpha"),
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 262144,
                maxTokens: 65536,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const models = buildInlineProviderModels(cfg.models?.providers ?? {});
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openrouter",
          id: "openrouter/healer-alpha",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 262144,
          maxTokens: 65536,
        }),
      ]),
    );
    expect(models.find((model) => model.id === "openrouter/healer-alpha")).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("uses OpenRouter API capabilities for unknown models when cache is populated", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue({
      name: "Healer Alpha",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      name: "Healer Alpha",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 65536,
    });
  });

  it("falls back to text-only when OpenRouter API cache is empty", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      reasoning: false,
      input: ["text"],
    });
  });

  it("matches prefixed Hugging Face ids against discovered registry models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "huggingface",
      modelId: "deepseek-ai/DeepSeek-R1",
      templateModel: {
        ...makeModel("deepseek-ai/DeepSeek-R1"),
        provider: "huggingface",
        baseUrl: "https://router.huggingface.co/v1",
        reasoning: true,
        input: ["text"],
      },
    });

    const result = resolveModelForTest(
      "huggingface",
      "huggingface/deepseek-ai/DeepSeek-R1",
      "/tmp/agent",
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "huggingface",
      id: "deepseek-ai/DeepSeek-R1",
      reasoning: true,
      input: ["text"],
    });
  });

  it("preloads OpenRouter capabilities before first async resolve of an unknown model", async () => {
    mockLoadOpenRouterModelCapabilities.mockImplementation(async (modelId) => {
      if (modelId === "google/gemini-3.1-flash-image-preview") {
        mockGetOpenRouterModelCapabilities.mockReturnValue({
          name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 65536,
          maxTokens: 65536,
          cost: { input: 0.5, output: 3, cacheRead: 0, cacheWrite: 0 },
        });
      }
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "google/gemini-3.1-flash-image-preview",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).toHaveBeenCalledWith(
      "google/gemini-3.1-flash-image-preview",
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "google/gemini-3.1-flash-image-preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 65536,
      maxTokens: 65536,
    });
  });

  it("skips OpenRouter preload for models already present in the registry", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openrouter/healer-alpha",
      templateModel: {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
      },
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "openrouter/healer-alpha",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
    });
  });

  it("prefers configured provider api metadata over discovered registry model", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "onehub",
      modelId: "glm-5",
      templateModel: {
        id: "glm-5",
        name: "GLM-5 (cached)",
        provider: "onehub",
        api: "anthropic-messages",
        baseUrl: "https://old-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          onehub: {
            baseUrl: "http://new-provider.example.com/v1",
            api: "openai-completions",
            models: [
              {
                ...makeModel("glm-5"),
                api: "openai-completions",
                reasoning: true,
                contextWindow: 198000,
                maxTokens: 16000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("onehub", "glm-5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "onehub",
      id: "glm-5",
      api: "openai-completions",
      baseUrl: "http://new-provider.example.com/v1",
      reasoning: true,
      contextWindow: 198000,
      maxTokens: 16000,
    });
  });

  it("prefers exact provider config over normalized alias match when both keys exist", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "bedrock",
      modelId: "bedrock-alias-exact-test",
      templateModel: {
        id: "bedrock-alias-exact-test",
        name: "Bedrock alias test",
        provider: "bedrock",
        api: "openai-completions",
        baseUrl: "https://default-provider.example.com/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    });

    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://canonical-bedrock.example.com/v1",
            api: "openai-completions",
            headers: { "X-Provider": "canonical" },
            models: [{ ...makeModel("bedrock-alias-exact-test"), reasoning: false }],
          },
          bedrock: {
            baseUrl: "https://alias-bedrock.example.com/v1",
            api: "anthropic-messages",
            headers: { "X-Provider": "alias" },
            models: [
              {
                ...makeModel("bedrock-alias-exact-test"),
                api: "anthropic-messages",
                reasoning: true,
                contextWindow: 262144,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("bedrock", "bedrock-alias-exact-test", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "bedrock",
      id: "bedrock-alias-exact-test",
      api: "anthropic-messages",
      baseUrl: "https://alias-bedrock.example.com",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32768,
      headers: { "X-Provider": "alias" },
    });
  });

  it("builds an openai-codex fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("upgrades stale exact openai-codex gpt-5.4 registry metadata via forward-compat", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai-codex") {
          return null;
        }
        if (modelId === "gpt-5.4") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.4",
            name: "GPT-5.4",
            contextWindow: 272000,
          };
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128000,
    });
  });

  it("does not downgrade exact openai-codex gpt-5.3-codex registry metadata", () => {
    vi.mocked(discoverModels).mockReturnValue({
      find: vi.fn((provider: string, modelId: string) => {
        if (provider !== "openai-codex") {
          return null;
        }
        if (modelId === "gpt-5.3-codex") {
          return {
            ...OPENAI_CODEX_TEMPLATE_MODEL,
            id: "gpt-5.3-codex",
            name: "GPT-5.3 Codex",
            contextWindow: 272000,
          };
        }
        return null;
      }),
    } as unknown as ReturnType<typeof discoverModels>);

    const result = resolveModelForTest("openai-codex", "gpt-5.3-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      contextWindow: 272000,
      maxTokens: 128000,
    });
  });

  it("canonicalizes the legacy openai-codex gpt-5.4-codex alias at runtime", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.4-codex", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.name).toBe("gpt-5.4");
  });

  it("applies canonical openai-codex overrides when resolving the gpt-5.4-codex alias", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://proxy.example.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 123456,
                contextTokens: 65432,
                maxTokens: 7777,
                reasoning: false,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.4-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://proxy.example.com/backend-api",
      contextWindow: 123456,
      contextTokens: 65432,
      maxTokens: 7777,
      reasoning: false,
    });
  });

  it("prefers alias-specific overrides over canonical ones for gpt-5.4-codex", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            models: [
              {
                ...makeModel("gpt-5.4"),
                contextWindow: 222222,
                maxTokens: 22222,
              },
              {
                ...makeModel("gpt-5.4-codex"),
                contextWindow: 111111,
                maxTokens: 11111,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.4-codex", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      contextWindow: 111111,
      maxTokens: 11111,
    });
  });

  it("builds an openai-codex fallback for gpt-5.4-mini", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
      contextWindow: 400_000,
      contextTokens: 272_000,
    });
  });

  it("does not build an openai-codex fallback for removed gpt-5.3-codex-spark", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai-codex/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    );
  });

  it("rejects stale openai-codex gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
        name: "GPT-5.3 Codex Spark",
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai-codex/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    );
  });

  it("prefers runtime-resolved openai-codex gpt-5.4 metadata when it has a larger context window", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("lets official openai-codex metadata override stale configured model rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
      },
    });

    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                ...makeModel("gpt-5.5-pro"),
                api: "openai-codex-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 400_000,
                contextTokens: 64_000,
                maxTokens: 32_000,
                metadataSource: "models-add",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.5-pro", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.5-pro",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("resolves openai-codex gpt-5.5 even when discovery omits the OAuth catalog row", () => {
    const result = resolveModelForTest("openai-codex", "gpt-5.5");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.5",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("preserves unmarked manual openai-codex metadata overrides", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.5"),
        name: "GPT-5.5",
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 400_000,
      },
    });

    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [
              {
                ...makeModel("gpt-5.5"),
                api: "openai-codex-responses",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
                contextWindow: 555_555,
                contextTokens: 111_111,
                maxTokens: 22_222,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.5",
      cost: { input: 9, output: 99, cacheRead: 0.9, cacheWrite: 0 },
      contextWindow: 555_555,
      contextTokens: 111_111,
      maxTokens: 22_222,
    });
  });

  it("prefers runtime-resolved openai-codex gpt-5.4 metadata during async resolution too", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
      },
    });

    const result = await resolveModelAsyncForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("normalizes stale discovered openai-codex /backend-api/v1 metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        baseUrl: "https://chatgpt.com/backend-api/v1",
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("normalizes stale discovered openrouter /v1 metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      templateModel: {
        provider: "openrouter",
        id: "openai/gpt-5.4",
        name: "GPT-5.4",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    });

    const result = resolveModelForTest("openrouter", "openai/gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openrouter",
      id: "openai/gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("normalizes discovered openai-codex metadata when api is missing", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        api: undefined,
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("passes configured workspaceDir to runtime preference hooks", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        name: "GPT-5.4",
        contextWindow: 128_000,
        contextTokens: 32_000,
      },
    });

    const shouldPreferRuntimeResolvedModel = vi.fn(
      (params: { workspaceDir?: string; context: { agentDir?: string } }) =>
        params.workspaceDir === "/tmp/workspace" && params.context.agentDir === "/tmp/agent-state",
    );
    const runProviderDynamicModel = vi.fn(
      (params: { workspaceDir?: string; context: { provider: string; modelId: string } }) =>
        params.workspaceDir === "/tmp/workspace" &&
        params.context.provider === "openai-codex" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      shouldPreferProviderRuntimeResolvedModel: shouldPreferRuntimeResolvedModel,
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent-state", cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent-state"),
      runtimeHooks,
    });

    expect(shouldPreferRuntimeResolvedModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        workspaceDir: "/tmp/workspace",
        context: expect.objectContaining({
          agentDir: "/tmp/agent-state",
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
    expect(runProviderDynamicModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
        workspaceDir: "/tmp/workspace",
        context: expect.objectContaining({
          agentDir: "/tmp/agent-state",
          modelId: "gpt-5.4",
          provider: "openai-codex",
        }),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("resolves discovered openai-codex gpt-5.4-mini rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
        name: "GPT-5.4 Mini",
        contextWindow: 64_000,
        input: ["text"],
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      name: "GPT-5.4 Mini",
      contextWindow: 64_000,
      input: ["text"],
    });
  });

  it("rejects stale direct openai gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    );
  });

  it("applies provider overrides to openai gpt-5.4 forward-compat models", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("applies configured overrides to github-copilot dynamic models", () => {
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            baseUrl: "https://proxy.example.com/v1",
            api: "openai-completions",
            headers: { "X-Proxy-Auth": "token-123" },
            models: [
              {
                ...makeModel("gpt-5.4-mini"),
                reasoning: true,
                input: ["text"],
                contextWindow: 256000,
                maxTokens: 32000,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("github-copilot", "gpt-5.4-mini", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "github-copilot",
      id: "gpt-5.4-mini",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 256000,
      maxTokens: 32000,
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("resolves github-copilot Claude dynamic models to anthropic-messages by default", () => {
    const result = resolveModelForTest("github-copilot", "claude-sonnet-4.6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
      api: "anthropic-messages",
    });
  });

  it("builds an openai fallback for gpt-5.4 mini from the gpt-5.4-mini template", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-mini",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("builds an openai fallback for gpt-5.4 nano from the gpt-5.4-nano template", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4-nano",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-nano", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("normalizes stale native openai gpt-5.4 completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("keeps proxied openai completions transport untouched", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.4",
      templateModel: buildForwardCompatTemplate({
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
    });
  });

  it("normalizes stale native xai completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.20-beta-latest-reasoning",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.20-beta-latest-reasoning",
        name: "Grok 4.20 Beta Latest (Reasoning)",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = resolveModelForTest("xai", "grok-4.20-beta-latest-reasoning", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "xai",
      id: "grok-4.20-beta-latest-reasoning",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("normalizes stale native xai completions transport after plugin model normalization", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.20-beta-latest-reasoning",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.20-beta-latest-reasoning",
        name: "Grok 4.20 Beta Latest (Reasoning)",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = resolveModel("xai", "grok-4.20-beta-latest-reasoning", "/tmp/agent", undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: {
        applyProviderResolvedModelCompatWithPlugins: () => undefined,
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        prepareProviderDynamicModel: async () => {},
        runProviderDynamicModel: () => undefined,
        applyProviderResolvedTransportWithPlugin: ({ provider, context }) =>
          provider === "xai" &&
          context.model.api === "openai-completions" &&
          context.model.baseUrl === "https://api.x.ai/v1"
            ? {
                ...context.model,
                api: "openai-responses",
              }
            : undefined,
        normalizeProviderResolvedModelWithPlugin: ({ provider, context }) =>
          provider === "xai" ? (context.model as never) : undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "xai",
      id: "grok-4.20-beta-latest-reasoning",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });
});
