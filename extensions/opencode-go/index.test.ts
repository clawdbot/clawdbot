import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
// Opencode Go tests cover index plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeGoLiveProviderConfig,
  buildStaticOpencodeGoProviderConfig,
  resolveOpencodeGoStarterModel,
} from "./provider-catalog.js";
import opencodeGoProviderDiscovery from "./provider-discovery.js";

const requireRecord = createRequireRecord("record", "expected-label-record");

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

function runtimeCompatFields(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  const { codeMode: _codeMode, ...compat } = requireRecord(value, "model compat");
  return compat;
}

const ACTIVE_MODEL_IDS = [
  "qwen3.7-plus",
  "glm-5.1",
  "deepseek-v4-flash",
  "minimax-m2.7",
  "glm-5.2",
  "qwen3.7-max",
  "kimi-k2.6",
  "minimax-m3",
  "hy3",
  "deepseek-v4-pro",
  "qwen3.8-max",
  "mimo-v2.5",
  "gpt-5.6-luna",
  "grok-4.5",
  "kimi-k2.7-code",
  "kimi-k3",
  "mimo-v2.5-pro",
  "qwen3.6-plus",
] as const;
const DEPRECATED_MODEL_IDS = [
  "glm-5",
  "qwen3.5-plus",
  "mimo-v2-omni",
  "kimi-k2.5",
  "mimo-v2-pro",
  "minimax-m2.5",
] as const;

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
      groupHint: "Shared API key infrastructure for Zen + Go",
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

    const expectedModelIds = [...ACTIVE_MODEL_IDS, ...DEPRECATED_MODEL_IDS, "hy3-preview"];
    expect(new Set(expectedModelIds).size).toBe(expectedModelIds.length);
    const models = new Map<string, ProviderRuntimeModel>();
    for (const modelId of expectedModelIds) {
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected OpenCode Go model ${modelId}`);
      }
      models.set(model.id, model);
    }
    expect([...models.keys()].toSorted()).toEqual(expectedModelIds.toSorted());
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "deepseek-v4-pro",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["high", "max"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "deepseek-v4-flash",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "high", "max"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "kimi-k3",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["max"] },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "max" }], defaultLevel: "off" });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "glm-5",
        api: "openai-completions",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off", label: "always on" }], defaultLevel: "off" });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "grok-4.5",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "minimax-m2.7",
        api: "anthropic-messages",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "high", label: "always on" }], defaultLevel: "high" });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "opencode-go",
        modelId: "minimax-m3",
        api: "anthropic-messages",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high", label: "on" }],
      defaultLevel: "high",
    });
    const supplemental = await provider.augmentModelCatalog?.({
      entries: [...models.values()].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      })),
    } as never);
    const supplementalIds = (supplemental ?? []).map((entry) => entry.id);
    expect(new Set(supplementalIds).size).toBe(supplementalIds.length);
    expect(supplementalIds.toSorted()).toEqual(expectedModelIds.toSorted());
    const deepSeekPro = requireCatalogEntry(supplemental, "deepseek-v4-pro");
    expect(deepSeekPro.provider).toBe("opencode-go");
    expect(deepSeekPro.name).toBe("DeepSeek V4 Pro");
    const deepSeekFlash = requireCatalogEntry(supplemental, "deepseek-v4-flash");
    expect(deepSeekFlash.provider).toBe("opencode-go");
    expect(deepSeekFlash.name).toBe("DeepSeek V4 Flash");
    for (const modelId of DEPRECATED_MODEL_IDS) {
      expect(requireCatalogEntry(supplemental, modelId).status).toBe("deprecated");
      expect(requireCatalogEntry(supplemental, modelId).replacedBy).toBeUndefined();
    }
    for (const modelId of ACTIVE_MODEL_IDS) {
      expect(requireCatalogEntry(supplemental, modelId).status).toBeUndefined();
    }
    expect(requireCatalogEntry(supplemental, "hy3-preview").status).toBe("preview");

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

    expect(requireMapEntry(models, "kimi-k3")).toMatchObject({
      api: "openai-completions",
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["max"] },
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
    expect(minimaxM3.input).toEqual(["text", "image"]);
    expect(minimaxM3.contextWindow).toBe(1_000_000);
    expect(minimaxM3.maxTokens).toBe(131_072);

    const mimoPro = requireMapEntry(models, "mimo-v2.5-pro");
    expect(mimoPro.api).toBe("openai-completions");
    expect(mimoPro.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(mimoPro.input).toEqual(["text"]);
    expect(mimoPro.reasoning).toBe(true);
    expect(mimoPro.contextWindow).toBe(1_048_576);
    expect(mimoPro.maxTokens).toBe(128_000);

    const mimo = requireMapEntry(models, "mimo-v2.5");
    expect(mimo.input).toEqual(["text", "image"]);
    expect(mimo.reasoning).toBe(true);
    expect(mimo.contextWindow).toBe(1_000_000);
    expect(mimo.maxTokens).toBe(128_000);

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

  it("loads model discovery and keeps every promoted row identical to runtime", async () => {
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog.discovery["opencode-go"]).toBe("runtime");
    const manifestProvider = requireRecord(
      manifest.modelCatalog.providers["opencode-go"],
      "manifest provider",
    );
    if (!Array.isArray(manifestProvider.models)) {
      throw new Error("expected manifest models");
    }
    const manifestIds = manifestProvider.models.map((model) =>
      String(requireRecord(model, "manifest model").id),
    );
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    const provider = await registerSingleProviderPlugin(plugin);
    for (const manifestModel of manifestProvider.models) {
      const model = requireRecord(manifestModel, "manifest model");
      const modelId = String(model.id);
      const runtime = requireRecord(
        provider.resolveDynamicModel?.({ modelId } as never),
        `runtime model ${modelId}`,
      );
      expect({
        api: model.api ?? manifestProvider.api,
        baseUrl: model.baseUrl ?? manifestProvider.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        contextTokens: model.contextTokens,
        maxTokens: model.maxTokens,
        thinkingLevelMap: model.thinkingLevelMap,
        cost: model.cost,
        compat: runtimeCompatFields(model.compat),
      }).toEqual({
        api: runtime.api,
        baseUrl: runtime.baseUrl,
        reasoning: runtime.reasoning,
        input: runtime.input,
        contextWindow: runtime.contextWindow,
        contextTokens: runtime.contextTokens,
        maxTokens: runtime.maxTokens,
        thinkingLevelMap: runtime.thinkingLevelMap,
        cost: runtime.cost,
        compat: runtimeCompatFields(runtime.compat),
      });
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

    const modelIds = result.provider.models.map((model) => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds.toSorted()).toEqual(ACTIVE_MODEL_IDS.toSorted());
    expect(deepSeekPro).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: { supportedReasoningEfforts: ["high", "max"] },
    });
    expect(deepSeekFlash).toMatchObject({
      provider: "opencode-go",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: { supportedReasoningEfforts: ["low", "high", "max"] },
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

  it("keeps compatibility rows explicit-resolvable but out of static and live catalogs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const compatibilityModelIds = [...DEPRECATED_MODEL_IDS, "hy3-preview"];
    const activeModelIds = ["mimo-v2.5", "mimo-v2.5-pro"];
    const staticModelIds = buildStaticOpencodeGoProviderConfig().models.map((model) => model.id);

    expect(new Set(staticModelIds).size).toBe(staticModelIds.length);
    expect(staticModelIds.toSorted()).toEqual(ACTIVE_MODEL_IDS.toSorted());
    expect(staticModelIds).toEqual(expect.not.arrayContaining(compatibilityModelIds));
    for (const modelId of compatibilityModelIds) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({ id: modelId });
    }

    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [...compatibilityModelIds, ...activeModelIds].map((id) => ({
            id,
            object: "model",
          })),
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

  it.each([
    [["deepseek-v4-pro"], "opencode-go/deepseek-v4-pro"],
    [["glm-5.1"], undefined],
  ])("selects only the advertised preferred onboarding model %#", async (modelIds, expected) => {
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }),
      ),
      finalUrl: "https://opencode.ai/zen/go/v1/models",
      release: vi.fn(async () => undefined),
    }));

    await expect(
      resolveOpencodeGoStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode-go/deepseek-v4-pro",
        fetchGuard,
      }),
    ).resolves.toBe(expected);
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
    const liveIds = ["minimax-m3", "qwen3.7-max", "qwen3.7-plus"];
    expect(first.models.map((model) => model.id).toSorted()).toEqual(liveIds);
    expect(second.models.map((model) => model.id).toSorted()).toEqual(liveIds);

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpencodeGoLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(fallback.apiKey).toBe("OPENCODE_API_KEY");
    expect(fallback.models.map((model) => model.id).toSorted()).toEqual(
      ACTIVE_MODEL_IDS.toSorted(),
    );
  });

  it("does not synthesize a stream when the runtime provides none", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.wrapStreamFn?.({ streamFn: undefined } as never)).toBeUndefined();
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
    ["glm-5.2", "max", undefined],
    ["grok-4.5", "high", undefined],
    ["hy3", "low", "none"],
  ] as const)(
    "maps %s only to supported wire efforts",
    async (modelId, enabledEffort, offEffort) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected ${modelId}`);
      }
      const context = {
        systemPrompt: "",
        messages: [{ role: "user", content: "test", timestamp: 1 }],
      } as never;

      const offPayload = buildOpenAICompletionsParams(model as never, context, {
        reasoning: "off",
      } as never);
      if (offEffort === undefined) {
        expect(offPayload).not.toHaveProperty("reasoning_effort");
      } else {
        expect(offPayload).toHaveProperty("reasoning_effort", offEffort);
      }
      expect(
        buildOpenAICompletionsParams(model as never, context, {
          reasoning: enabledEffort,
        } as never),
      ).toHaveProperty("reasoning_effort", enabledEffort);
    },
  );

  it.each([
    ["low", "low"],
    ["high", "high"],
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

  it.each(["minimax-m2.5", "minimax-m2.7"])(
    "keeps fixed-reasoning %s on the provider default wire path",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const capturedPayloads: Record<string, unknown>[] = [];
      const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
        const payload = {
          model: modelId,
          thinking: { type: "enabled", budget_tokens: 8192 },
          output_config: { effort: "high" },
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
        thinkingLevel: "high",
      } as never);

      await streamFn?.(
        { provider: "opencode-go", id: modelId, api: "anthropic-messages" } as never,
        {} as never,
        {},
      );
      expect(capturedPayloads).toEqual([{ model: modelId }]);
    },
  );

  it.each([
    ["off", undefined],
    ["max", "max"],
  ] as const)("keeps Kimi K3 reasoning %s exact", async (thinkingLevel, expectedEffort) => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload: Record<string, unknown> = {
        model: "kimi-k3",
        reasoning_effort: "max",
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode-go",
      modelId: "kimi-k3",
      thinkingLevel,
    } as never);

    await streamFn?.(
      { provider: "opencode-go", id: "kimi-k3", api: "openai-completions" } as never,
      {} as never,
      {},
    );
    expect(capturedPayloads).toEqual([
      expectedEffort === undefined
        ? { model: "kimi-k3" }
        : { model: "kimi-k3", reasoning_effort: expectedEffort },
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
