// Coverage for forward-compatible model fallback errors and provider overrides.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/config.js";
import { discoverModels } from "../agent-model-discovery.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    prepareProviderDynamicModel: async () => {},
    runProviderDynamicModel: () => undefined,
  };
});

vi.mock("../model-suppression.js", () => ({
  shouldSuppressBuiltInModel: ({
    provider,
    id,
    baseUrl,
  }: {
    provider?: string;
    id?: string;
    baseUrl?: string;
  }) => {
    if (
      (provider !== "openai" && provider !== "azure-openai-responses") ||
      id?.trim().toLowerCase() !== "gpt-5.3-codex-spark"
    ) {
      return false;
    }
    if (provider === "azure-openai-responses") {
      return true;
    }
    if (!baseUrl) {
      return true;
    }
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  },
  shouldUnconditionallySuppress: () => false,
  buildSuppressedBuiltInModelError: ({ provider, id }: { provider?: string; id?: string }) => {
    if (
      (provider !== "openai" && provider !== "azure-openai-responses") ||
      id?.trim().toLowerCase() !== "gpt-5.3-codex-spark"
    ) {
      return undefined;
    }
    return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
  },
}));

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { resetModelDiscoveryCacheForTest } from "./model-discovery-cache.test-support.js";
import {
  expectResolvedForwardCompatFallbackResult,
  expectUnknownModelErrorResult,
} from "./model.forward-compat.test-support.js";
import { resolveModel } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetModelDiscoveryCacheForTest();
  resetMockDiscoverModels(discoverModels);
});

function createRuntimeHooks() {
  // Dynamic provider hooks are opt-in here so tests can distinguish runtime
  // fallback behavior from static catalog and discovery results.
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["google-antigravity", "zai", "openai"],
  });
}

function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
) {
  return resolveModel(provider, modelId, agentDir, cfg, {
    runtimeHooks: createRuntimeHooks(),
  });
}

function createAnthropicTemplateModel() {
  return {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function resolveAnthropicModelWithProviderOverrides(overrides: Partial<ModelProviderConfig>) {
  // Provider config overrides must merge onto discovered template models without
  // losing the template's API, cost, and capability metadata.
  mockDiscoveredModel(discoverModels, {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    templateModel: createAnthropicTemplateModel(),
  });

  return resolveModelForTest("anthropic", "claude-sonnet-4-5", "/tmp/agent", {
    models: {
      providers: {
        anthropic: overrides,
      },
    },
  } as unknown as OpenClawConfig);
}

describe("resolveModel forward-compat errors and overrides", () => {
  it("builds a forward-compat fallback for supported antigravity thinking ids", () => {
    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("google-antigravity", "claude-opus-4-6-thinking", "/tmp/agent"),
      expectedModel: {
        api: "google-gemini-cli",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        id: "claude-opus-4-6-thinking",
        provider: "google-antigravity",
        reasoning: true,
      },
    });
  });

  it("keeps unknown-model errors when no antigravity non-thinking template exists", () => {
    expectUnknownModelErrorResult(
      resolveModelForTest("google-antigravity", "claude-opus-4-6", "/tmp/agent"),
      "google-antigravity",
      "claude-opus-4-6",
    );
  });

  it("keeps unknown-model errors for non-gpt-5 openai ids", () => {
    expectUnknownModelErrorResult(
      resolveModelForTest("openai", "gpt-4.1-mini", "/tmp/agent"),
      "openai",
      "gpt-4.1-mini",
    );
  });

  it("rejects direct openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("keeps suppressed openai gpt-5.3-codex-spark from falling through provider fallback", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ ...makeModel("gpt-4.1"), api: "openai-responses" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("resolves suppressed openai gpt-5.3-codex-spark through ChatGPT/Codex routing", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(
      buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
    );
  });

  it("resolves suppressed openai gpt-5.3-codex-spark through model-scoped Codex runtime", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.3-codex-spark": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };
    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(
      buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
    );
  });

  it("keeps model-scoped Codex runtime blocked for explicit OpenAI API-key provider config", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.3-codex-spark": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
      models: {
        providers: {
          openai: {
            auth: "api-key",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("OpenAI API-key auth cannot use this model");
  });

  it("keeps suppressed stale direct openai gpt-5.3-codex-spark catalog rows blocked", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...makeModel("gpt-5.3-codex-spark"),
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ChatGPT/Codex OAuth");
  });

  it("keeps stale persisted openai gpt-5.3-codex-spark rows blocked without transport metadata", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...makeModel("gpt-5.3-codex-spark"),
        provider: "openai",
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ChatGPT/Codex OAuth");
  });

  it("keeps configured custom openai gpt-5.3-codex-spark rows when not direct OpenAI API", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://proxy.example/v1",
            models: [
              {
                ...makeModel("gpt-5.3-codex-spark"),
                api: "openai-responses",
                baseUrl: "https://proxy.example/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-responses",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("rejects configured direct openai gpt-5.3-codex-spark rows", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                ...makeModel("gpt-5.3-codex-spark"),
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ChatGPT/Codex OAuth");
    expect(result.error).toContain("OpenAI API-key auth cannot use this model");
  });

  it("keeps configured custom openai gpt-5.3-codex-spark rows that omit api", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            models: [
              {
                ...makeModel("gpt-5.3-codex-spark"),
                baseUrl: "https://proxy.example/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-responses",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("keeps registry openai gpt-5.3-codex-spark rows on custom provider endpoints", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...makeModel("gpt-5.3-codex-spark"),
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://proxy.example/v1",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-responses",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("checks registry baseUrl before suppressing openai gpt-5.3-codex-spark rows", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      templateModel: {
        ...makeModel("gpt-5.3-codex-spark"),
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      },
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-responses",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("rejects azure openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.3-codex-spark",
      "/tmp/agent",
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("rejects azure openai gpt-5.3-codex-spark through the openai owner when azure config has no matching model row", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [makeModel("gpt-5.5")],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.3-codex-spark",
      "/tmp/agent",
      cfg,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("keeps unconditional codex-only suppression on the openai owner when azure config has a matching model row", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [makeModel("gpt-5.3-codex-spark")],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.3-codex-spark",
      "/tmp/agent",
      cfg,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("keeps provider-level azure deployment names on the azure owner", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest(
      "azure-openai-responses",
      "customer-gpt-deployment",
      "/tmp/agent",
      cfg,
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "azure-openai-responses",
      id: "customer-gpt-deployment",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("uses retained azure alias transport defaults for provider-level deployment names", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest(
      "azure-openai-responses",
      "customer-gpt-deployment",
      "/tmp/agent",
      cfg,
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "azure-openai-responses",
      id: "customer-gpt-deployment",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it("rejects provider-level azure codex-only aliases through the openai owner", () => {
    const cfg = {
      models: {
        providers: {
          "azure-openai-responses": {
            baseUrl: "https://example.openai.azure.com/openai/v1",
            api: "azure-openai-responses",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.3-codex-spark",
      "/tmp/agent",
      cfg,
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("uses codex fallback even when openai provider is configured", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://custom.example.com",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-chatgpt-responses",
        id: "gpt-5.4",
        provider: "openai",
      },
    });
  });

  it("uses codex fallback when inline model omits api (#39682)", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://custom.example.com",
            headers: { "X-Custom-Auth": "token-123" },
            models: [{ id: "gpt-5.4" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("openai-chatgpt-responses");
    expect(result.model?.baseUrl).toBe("https://custom.example.com");
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.provider).toBe("openai");
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("keeps openai gpt-5.4 responses overrides on the OpenAI API transport", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      },
    });
  });

  it("normalizes openai gpt-5.4 completions overrides to the OpenAI API transport", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        provider: "openai",
      },
    });
  });

  it("includes auth hint for unknown ollama models (#17328)", () => {
    const result = resolveModelForTest("ollama", "gemma3:4b", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Unknown model: ollama/gemma3:4b");
    expect(result.error).toContain("OLLAMA_API_KEY");
    expect(result.error).toContain("docs.openclaw.ai/providers/ollama");
  });

  it("includes auth hint for unknown vllm models", () => {
    const result = resolveModelForTest("vllm", "llama-3-70b", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Unknown model: vllm/llama-3-70b");
    expect(result.error).toContain("VLLM_API_KEY");
  });

  it("does not add auth hint for non-local providers", () => {
    const result = resolveModelForTest("google-antigravity", "some-model", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-antigravity/some-model");
  });

  it("applies provider baseUrl override to registry-found models", () => {
    const result = resolveAnthropicModelWithProviderOverrides({
      baseUrl: "https://my-proxy.example.com",
    });
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://my-proxy.example.com");
  });

  it("applies provider headers override to registry-found models", () => {
    const result = resolveAnthropicModelWithProviderOverrides({
      headers: { "X-Custom-Auth": "token-123" },
    });
    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("lets provider config override registry-found kimi user agent headers", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "kimi",
      modelId: "kimi-code",
      templateModel: {
        id: "kimi-code",
        name: "Kimi Code",
        provider: "kimi",
        api: "anthropic-messages",
        baseUrl: "https://api.kimi.com/coding/",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
        headers: { "User-Agent": "claude-code/0.1.0" },
      },
    });

    const cfg = {
      models: {
        providers: {
          kimi: {
            headers: {
              "User-Agent": "custom-kimi-client/1.0",
              "X-Kimi-Tenant": "tenant-a",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("kimi", "kimi-code", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model?.id).toBe("kimi-code");
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "User-Agent": "custom-kimi-client/1.0",
      "X-Kimi-Tenant": "tenant-a",
    });
  });

  it("does not override when no provider config exists", () => {
    mockDiscoveredModel(discoverModels, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      templateModel: {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    });

    const result = resolveModelForTest("anthropic", "claude-sonnet-4-6", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://api.anthropic.com");
  });
});
