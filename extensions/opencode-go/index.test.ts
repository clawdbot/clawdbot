// Opencode Go tests cover index plugin behavior.
import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
} from "./provider-catalog.js";
import opencodeGoProviderDiscovery from "./provider-discovery.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireMapEntry<T>(map: Map<string, T>, id: string): T {
  const entry = map.get(id);
  if (!entry) {
    throw new Error(`expected model ${id}`);
  }
  return entry;
}

function requireCatalogEntry(entries: readonly unknown[] | null | undefined, id: string) {
  if (!entries) {
    throw new Error("expected supplemental catalog entries");
  }
  const entry = entries.find((candidate) => requireRecord(candidate, "catalog entry").id === id);
  if (!entry) {
    throw new Error(`expected supplemental catalog entry ${id}`);
  }
  return requireRecord(entry, `supplemental catalog entry ${id}`);
}

const deepSeekV4ThinkingProfileLevelIds = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const deepSeekV4ThinkingProfile = {
  levels: deepSeekV4ThinkingProfileLevelIds.map((id) => ({ id })),
  defaultLevel: "high",
};
const deepSeekV4ThinkingLevelMap = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

function expectDeepSeekV4ThinkingLevels(model: ProviderRuntimeModel) {
  expect(model.thinkingLevelMap).toEqual(deepSeekV4ThinkingLevelMap);
  expect(clampThinkingLevel(model, "off")).toBe("off");
  expect(clampThinkingLevel(model, "high")).toBe("high");
  expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
  expect(clampThinkingLevel(model, "max")).toBe("max");
}

describe("opencode-go provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("registers only the Go auth choice from its own provider manifest", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("opencode-go");
    expect(provider.envVars).toEqual(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]);
    expect(provider.auth.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["opencode-go"]);
    expect(provider.auth[0]?.wizard).toMatchObject({
      choiceLabel: "OpenCode Go catalog",
      groupId: "opencode",
      groupHint: "Shared API key for Zen + Go catalogs",
    });
  });

  it("registers image media understanding through the OpenCode Go plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode-go",
      name: "OpenCode Go Provider",
    });

    const mediaProvider = mediaProviders.find((provider) => provider.id === "opencode-go");
    if (!mediaProvider) {
      throw new Error("Expected opencode-go media provider");
    }
    expect(mediaProvider.capabilities).toEqual(["image"]);
    expect(mediaProvider.defaultModels).toEqual({ image: "kimi-k2.6" });
    expect(typeof mediaProvider.describeImage).toBe("function");
    expect(typeof mediaProvider.describeImages).toBe("function");
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "qwen3-coder",
    });
  });

  it("keeps OpenCode Go catalog coverage aligned with upstream", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.catalog).toBeDefined();

    const expectedModelIds = [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "gpt-5.6-luna",
      "grok-4.5",
      "hy3",
      "hy3-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-max",
    ];
    const models = new Map<string, ProviderRuntimeModel>();
    for (const modelId of expectedModelIds) {
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected OpenCode Go model ${modelId}`);
      }
      models.set(model.id, model);
    }
    expect([...models.keys()]).toEqual(expectedModelIds);
    expectDeepSeekV4ThinkingLevels(requireMapEntry(models, "deepseek-v4-pro"));
    expectDeepSeekV4ThinkingLevels(requireMapEntry(models, "deepseek-v4-flash"));
    expect(
      provider.resolveThinkingProfile?.({ provider: "opencode-go", modelId: "deepseek-v4-pro" }),
    ).toEqual(deepSeekV4ThinkingProfile);
    expect(
      provider.resolveThinkingProfile?.({ provider: "opencode-go", modelId: "deepseek-v4-flash" }),
    ).toEqual(deepSeekV4ThinkingProfile);
    expect(
      provider.resolveThinkingProfile?.({ provider: "opencode-go", modelId: "glm-5" }),
    ).toBeUndefined();
    const supplemental = await provider.augmentModelCatalog?.({
      entries: [...models.values()].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      })),
    } as never);
    const deepSeekPro = requireCatalogEntry(supplemental, "deepseek-v4-pro");
    expect(deepSeekPro.provider).toBe("opencode-go");
    expect(deepSeekPro.name).toBe("DeepSeek V4 Pro");
    const deepSeekFlash = requireCatalogEntry(supplemental, "deepseek-v4-flash");
    expect(deepSeekFlash.provider).toBe("opencode-go");
    expect(deepSeekFlash.name).toBe("DeepSeek V4 Flash");

    const glm52 = requireMapEntry(models, "glm-5.2");
    expect(glm52.api).toBe("openai-completions");
    expect(glm52.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(glm52.input).toEqual(["text"]);
    expect(glm52.reasoning).toBe(true);
    expect(glm52.contextWindow).toBe(1_000_000);
    expect(glm52.maxTokens).toBe(131_072);
    expect(glm52.cost).toEqual({
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0,
    });

    const kimi = requireMapEntry(models, "kimi-k2.6");
    expect(kimi.api).toBe("openai-completions");
    expect(kimi.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(kimi.input).toEqual(["text", "image"]);
    expect(kimi.reasoning).toBe(true);
    expect(kimi.contextWindow).toBe(262_144);
    expect(kimi.maxTokens).toBe(65_536);

    const kimiCode = requireMapEntry(models, "kimi-k2.7-code");
    expect(kimiCode.api).toBe("openai-completions");
    expect(kimiCode.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(kimiCode.input).toEqual(["text", "image"]);
    expect(kimiCode.contextWindow).toBe(262_144);
    expect(kimiCode.maxTokens).toBe(262_144);
    expect(kimiCode.cost).toEqual({
      input: 0.95,
      output: 4,
      cacheRead: 0.19,
      cacheWrite: 0,
    });

    const minimax = requireMapEntry(models, "minimax-m2.7");
    expect(minimax.api).toBe("anthropic-messages");
    expect(minimax.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(minimax.reasoning).toBe(true);
    expect(minimax.contextWindow).toBe(204_800);
    expect(minimax.maxTokens).toBe(131_072);

    const minimaxM3 = requireMapEntry(models, "minimax-m3");
    expect(minimaxM3.api).toBe("anthropic-messages");
    expect(minimaxM3.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(minimaxM3.reasoning).toBe(true);
    expect(minimaxM3.contextWindow).toBe(1_000_000);
    expect(minimaxM3.maxTokens).toBe(131_072);
    expect(minimaxM3.cost).toMatchObject({
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0,
      tieredPricing: [
        { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0, range: [0, 512_000] },
        { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0, range: [512_000] },
      ],
    });

    const kimiK3 = requireMapEntry(models, "kimi-k3");
    expect(kimiK3.api).toBe("openai-completions");
    expect(kimiK3.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(kimiK3.input).toEqual(["text", "image"]);
    expect(kimiK3.reasoning).toBe(true);
    expect(kimiK3.contextWindow).toBe(1_048_576);
    expect(kimiK3.maxTokens).toBe(131_072);
    expect(kimiK3.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0,
    });

    const hy3 = requireMapEntry(models, "hy3");
    expect(hy3).toMatchObject({
      name: "Hy3",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 64_000,
      cost: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
    });

    const grok45 = requireMapEntry(models, "grok-4.5");
    expect(grok45).toMatchObject({
      name: "Grok 4.5",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 500_000,
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.5,
        cacheWrite: 0,
        tieredPricing: [
          { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, range: [0, 200_000] },
          { input: 4, output: 12, cacheRead: 1, cacheWrite: 0, range: [200_000] },
        ],
      },
    });

    const mimoPro = requireMapEntry(models, "mimo-v2.5-pro");
    expect(mimoPro.api).toBe("openai-completions");
    expect(mimoPro.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(mimoPro.input).toEqual(["text"]);
    expect(mimoPro.reasoning).toBe(true);
    expect(mimoPro.contextWindow).toBe(1_048_576);
    expect(mimoPro.maxTokens).toBe(128_000);
    expect(mimoPro.cost).toEqual({
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    });

    const mimo = requireMapEntry(models, "mimo-v2.5");
    expect(mimo.input).toEqual(["text", "image"]);
    expect(mimo.reasoning).toBe(true);
    expect(mimo.contextWindow).toBe(1_000_000);
    expect(mimo.maxTokens).toBe(128_000);
    expect(mimo.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    });

    const qwenMax = requireMapEntry(models, "qwen3.7-max");
    expect(qwenMax.api).toBe("anthropic-messages");
    expect(qwenMax.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(qwenMax.input).toEqual(["text"]);
    expect(qwenMax.reasoning).toBe(true);
    expect(qwenMax.contextWindow).toBe(1_000_000);
    expect(qwenMax.maxTokens).toBe(65_536);
    expect(requireRecord(qwenMax.compat, "Qwen3.7 compat")).toMatchObject({
      thinkingFormat: "qwen",
    });

    const qwenPlus = requireMapEntry(models, "qwen3.6-plus");
    expect(qwenPlus.api).toBe("anthropic-messages");
    expect(qwenPlus.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(qwenPlus.contextWindow).toBe(1_000_000);
    expect(qwenPlus.maxTokens).toBe(65_536);
    expect(qwenPlus.cost).toMatchObject({
      input: 0.5,
      output: 3,
      cacheRead: 0.05,
      cacheWrite: 0.625,
      tieredPricing: [
        {
          input: 0.5,
          output: 3,
          cacheRead: 0.05,
          cacheWrite: 0.625,
          range: [0, 256_000],
        },
        {
          input: 2,
          output: 6,
          cacheRead: 0.2,
          cacheWrite: 2.5,
          range: [256_000],
        },
      ],
    });

    const qwen37Plus = requireMapEntry(models, "qwen3.7-plus");
    expect(qwen37Plus.api).toBe("anthropic-messages");
    expect(qwen37Plus.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(qwen37Plus.input).toEqual(["text", "image"]);
    expect(qwen37Plus.reasoning).toBe(true);
    expect(qwen37Plus.contextWindow).toBe(1_000_000);
    expect(qwen37Plus.maxTokens).toBe(65_536);
    expect(qwen37Plus.cost).toMatchObject({
      input: 0.4,
      output: 1.6,
      cacheRead: 0.04,
      cacheWrite: 0.5,
    });

    const gpt56Luna = requireMapEntry(models, "gpt-5.6-luna");
    expect(gpt56Luna).toMatchObject({
      name: "GPT-5.6 Luna",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 0.1,
        output: 0.6,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tieredPricing: [
          { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125, range: [0, 272_000] },
          { input: 0.2, output: 0.9, cacheRead: 0.02, cacheWrite: 0.25, range: [272_000] },
        ],
      },
    });
    expect(gpt56Luna.compat).toMatchObject({
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      maxTokensField: "max_tokens",
    });

    const qwen38Max = requireMapEntry(models, "qwen3.8-max");
    expect(qwen38Max).toMatchObject({
      name: "Qwen3.8 Max",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
    });
    expect(requireRecord(qwen38Max.compat, "Qwen3.8 compat")).toMatchObject({
      thinkingFormat: "qwen",
    });

    const dynamicModel = requireRecord(
      provider.resolveDynamicModel?.({
        modelId: "deepseek-v4-pro",
      } as never),
      "dynamic model",
    );
    expect(dynamicModel.id).toBe("deepseek-v4-pro");
    expect(dynamicModel.api).toBe("openai-completions");
    expect(dynamicModel.provider).toBe("opencode-go");
    expect(dynamicModel.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(dynamicModel.reasoning).toBe(true);
    expect(dynamicModel.contextWindow).toBe(1_000_000);
    expect(dynamicModel.maxTokens).toBe(384_000);
    const compat = requireRecord(dynamicModel.compat, "dynamic model compat");
    expect(compat.supportsUsageInStreaming).toBe(true);
    expect(compat.supportsReasoningEffort).toBe(true);
    expect(compat.maxTokensField).toBe("max_tokens");
  });

  it("loads OpenCode Go model discovery through the provider runtime", async () => {
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog.discovery["opencode-go"]).toBe("runtime");
    const manifestProvider = requireRecord(
      manifest.modelCatalog.providers["opencode-go"],
      "manifest provider",
    );
    if (!Array.isArray(manifestProvider.models)) {
      throw new Error("expected manifest models");
    }
    expect(
      manifestProvider.models.map((model) => requireRecord(model, "manifest model").id),
    ).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "hy3", "grok-4.5"]);
    expect(
      requireCatalogEntry(manifestProvider.models, "deepseek-v4-pro").thinkingLevelMap,
    ).toEqual(deepSeekV4ThinkingLevelMap);
    expect(
      requireCatalogEntry(manifestProvider.models, "deepseek-v4-flash").thinkingLevelMap,
    ).toEqual(deepSeekV4ThinkingLevelMap);

    const provider = await registerSingleProviderPlugin(plugin);
    for (const modelId of ["deepseek-v4-pro", "deepseek-v4-flash", "kimi-k3", "hy3", "grok-4.5"]) {
      const manifestModel = requireRecord(
        manifestProvider.models.find((model) => requireRecord(model, "m").id === modelId),
        `manifest ${modelId}`,
      );
      const runtimeModel = requireRecord(
        provider.resolveDynamicModel?.({ modelId } as never),
        `runtime ${modelId}`,
      );
      expect(manifestModel.cost).toEqual(runtimeModel.cost);
      expect(manifestModel.contextWindow).toBe(runtimeModel.contextWindow);
      expect(manifestModel.maxTokens).toBe(runtimeModel.maxTokens);
    }
  });

  it("exposes the complete offline catalog through provider discovery", async () => {
    const result = await opencodeGoProviderDiscovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Go static provider");
    }
    const deepSeekPro = result.provider.models.find((model) => model.id === "deepseek-v4-pro");
    const deepSeekFlash = result.provider.models.find((model) => model.id === "deepseek-v4-flash");
    const glm52 = result.provider.models.find((model) => model.id === "glm-5.2");

    expect(result.provider.models).toHaveLength(23);
    expect(deepSeekPro).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: deepSeekV4ThinkingLevelMap,
    });
    expect(deepSeekFlash).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: deepSeekV4ThinkingLevelMap,
    });
    expect(glm52).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    });
  });

  it("skips live OpenCode Go catalog discovery when no shared key is configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never),
    ).resolves.toBeNull();
  });

  it("keeps deprecated upstream MiMo aliases out of static and live catalogs", async () => {
    const deprecatedModelIds = ["mimo-v2-omni", "mimo-v2-pro"];
    const activeModelIds = ["mimo-v2.5", "mimo-v2.5-pro"];
    const staticModelIds = buildStaticOpencodeGoProviderConfig().models.map((model) => model.id);

    expect(staticModelIds).toEqual(expect.arrayContaining(activeModelIds));
    expect(staticModelIds).toEqual(expect.not.arrayContaining(deprecatedModelIds));

    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [...deprecatedModelIds, ...activeModelIds].map((id) => ({ id, object: "model" })),
        }),
      ),
      finalUrl: "https://opencode.ai/zen/go/v1/models",
      release: vi.fn(async () => undefined),
    }));
    const live = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(live.models.map((model) => model.id)).toEqual(activeModelIds);
  });

  it("does not mix provider-specific runtime auth with shared discovery auth", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    try {
      const result = await provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: (providerId: string) =>
          providerId === "opencode-go"
            ? {
                apiKey: NON_ENV_SECRETREF_MARKER,
                discoveryApiKey: undefined,
              }
            : {
                apiKey: "shared-opencode-key",
                discoveryApiKey: "shared-opencode-key",
              },
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never);

      if (!result || !("provider" in result)) {
        throw new Error("expected OpenCode Go provider result");
      }
      expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(result.provider.models.map((model) => model.id)).toContain("deepseek-v4-pro");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses cached live OpenCode Go discovery and falls back to static rows on failure", async () => {
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [
            { id: "minimax-m3", object: "model" },
            { id: "qwen3.7-max", object: "model" },
            { id: "qwen3.7-plus", object: "model" },
          ],
        }),
      ),
      finalUrl: "https://opencode.ai/zen/go/v1/models",
      release: vi.fn(async () => undefined),
    }));

    const first = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    const second = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("OPENCODE_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual([
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.7-plus",
    ]);
    expect(second.models.map((model) => model.id)).toEqual([
      "minimax-m3",
      "qwen3.7-max",
      "qwen3.7-plus",
    ]);

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(fallback.apiKey).toBe("OPENCODE_API_KEY");
    expect(fallback.models.map((model) => model.id)).toContain("deepseek-v4-pro");
    expect(fallback.models.map((model) => model.id)).toContain("minimax-m3");
  });

  it.each(["deepseek-v4-pro", "deepseek-v4-flash"] as const)(
    "disables invalid DeepSeek V4 reasoning_effort off payloads on OpenCode Go for %s",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const capturedPayloads: Record<string, unknown>[] = [];
      const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
        const payload = {
          model: modelId,
          reasoning_effort: "off",
          reasoning: "off",
        };
        (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(
          payload,
        );
        capturedPayloads.push(payload);
        return {} as never;
      };

      const streamFn = provider.wrapStreamFn?.({
        streamFn: baseStreamFn as never,
        providerId: "opencode-go",
        modelId,
        thinkingLevel: "off",
      } as never);

      expect(streamFn).toBeTypeOf("function");
      await streamFn?.({ provider: "opencode-go", id: modelId } as never, {} as never, {});

      expect(capturedPayloads).toEqual([
        {
          model: modelId,
          thinking: { type: "disabled" },
        },
      ]);
    },
  );

  it.each([
    ["minimal", "high"],
    ["low", "high"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
  ] as const)(
    "maps OpenCode Go DeepSeek V4 %s thinking to %s reasoning effort",
    async (thinkingLevel, reasoningEffort) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const capturedPayloads: Record<string, unknown>[] = [];
      const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
        const payload = { model: "deepseek-v4-flash" };
        (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(
          payload,
        );
        capturedPayloads.push(payload);
        return {} as never;
      };

      const streamFn = provider.wrapStreamFn?.({
        streamFn: baseStreamFn as never,
        providerId: "opencode-go",
        modelId: "deepseek-v4-flash",
        thinkingLevel,
      } as never);

      expect(streamFn).toBeTypeOf("function");
      await streamFn?.(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as never,
        {} as never,
        {},
      );

      expect(capturedPayloads).toEqual([
        {
          model: "deepseek-v4-flash",
          thinking: { type: "enabled" },
          reasoning_effort: reasoningEffort,
        },
      ]);
    },
  );

  it("does not apply DeepSeek V4 thinking payloads to unrelated OpenCode Go models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = { model: "glm-5", reasoning_effort: "max" };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode-go",
      modelId: "glm-5",
      thinkingLevel: "max",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.({ provider: "opencode-go", id: "glm-5" } as never, {} as never, {});

    expect(capturedPayloads).toEqual([{ model: "glm-5", reasoning_effort: "max" }]);
  });

  it("strips unsupported Kimi reasoning payloads on OpenCode Go", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "kimi-k2.6",
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode-go",
      modelId: "kimi-k2.6",
      thinkingLevel: "high",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.(
      { provider: "opencode-go", id: "kimi-k2.6", api: "openai-completions" } as never,
      {} as never,
      {},
    );

    expect(capturedPayloads).toEqual([
      {
        model: "kimi-k2.6",
      },
    ]);
  });

  it("canonicalizes stale OpenCode Go base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode-go",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/go/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        model: {
          provider: "opencode-go",
          id: "kimi-k2.5",
          name: "Kimi K2.5",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 65_536,
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen/go/v1");

    const normalizedKimi = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        model: {
          provider: "opencode-go",
          id: "kimi-k2.7-code",
          name: "Kimi K2.7 Code",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 262_144,
        },
      } as never),
      "normalized Kimi model",
    );
    expect(normalizedKimi.reasoning).toBe(false);
    expect(requireRecord(normalizedKimi.compat, "normalized Kimi compat")).toMatchObject({
      supportsReasoningEffort: false,
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/go/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "anthropic-messages",
        baseUrl: "https://opencode.ai/go",
      } as never),
    ).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
  });
});
