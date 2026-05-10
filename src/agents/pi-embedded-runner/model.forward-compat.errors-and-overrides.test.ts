import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/config.js";
import { discoverModels } from "../pi-model-discovery.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
    "../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    applyProviderResolvedModelCompatWithPlugins: () => undefined,
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    prepareProviderDynamicModel: async () => {},
    runProviderDynamicModel: () => undefined,
  };
});

vi.mock("../model-suppression.js", () => ({
  shouldSuppressBuiltInModel: ({ provider, id }: { provider?: string; id?: string }) =>
    (provider === "openai" ||
      provider === "azure-openai-responses" ||
      provider === "openai-codex") &&
    id?.trim().toLowerCase() === "gpt-5.3-codex-spark",
  buildSuppressedBuiltInModelError: ({ provider, id }: { provider?: string; id?: string }) => {
    if (
      (provider !== "openai" &&
        provider !== "azure-openai-responses" &&
        provider !== "openai-codex") ||
      id?.trim().toLowerCase() !== "gpt-5.3-codex-spark"
    ) {
      return undefined;
    }
    return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.`;
  },
}));

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenClawConfig } from "../../config/config.js";
import {
  expectResolvedForwardCompatFallbackResult,
  expectUnknownModelErrorResult,
} from "./model.forward-compat.test-support.js";
import { resolveModel } from "./model.js";
import {
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels(discoverModels);
});

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "google-antigravity", "zai", "openai-codex"],
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

  it("keeps unknown-model errors for non-gpt-5 openai-codex ids", () => {
    expectUnknownModelErrorResult(
      resolveModelForTest("openai-codex", "gpt-4.1-mini", "/tmp/agent"),
      "openai-codex",
      "gpt-4.1-mini",
    );
  });

  it("rejects direct openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
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
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    );
  });

  it("rejects azure openai gpt-5.3-codex-spark with a codex-only hint", () => {
    const result = resolveModelForTest(
      "azure-openai-responses",
      "gpt-5.3-codex-spark",
      "/tmp/agent",
    );

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
    );
  });

  it("uses codex fallback even when openai-codex provider is configured", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-codex-responses",
        id: "gpt-5.4",
        provider: "openai-codex",
      },
    });
  });

  it("uses codex fallback when inline model omits api (#39682)", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://custom.example.com",
            headers: { "X-Custom-Auth": "token-123" },
            models: [{ id: "gpt-5.4" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent", cfg);
    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("openai-codex-responses");
    expect(result.model?.baseUrl).toBe("https://custom.example.com");
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.provider).toBe("openai-codex");
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("normalizes openai-codex gpt-5.4 overrides away from /v1/responses", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
      },
    });
  });

  it("normalizes openai-codex gpt-5.4 back to codex transport", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
          },
        },
      },
    } as unknown as OpenClawConfig;

    expectResolvedForwardCompatFallbackResult({
      result: resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent", cfg),
      expectedModel: {
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
        provider: "openai-codex",
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
      modelId: "claude-sonnet-4-5",
      templateModel: {
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
      },
    });

    const result = resolveModelForTest("anthropic", "claude-sonnet-4-5", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.baseUrl).toBe("https://api.anthropic.com");
  });
});
