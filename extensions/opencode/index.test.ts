import { readFileSync } from "node:fs";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
// Opencode tests cover index plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";

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
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-nano",
  "grok-build-0.1",
  "grok-4.5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "glm-5.1",
  "minimax-m3",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-tiny-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
  "laguna-s-2.1-free",
  "longcat-2.0-free",
] as const;

const DEPRECATED_MODEL_IDS = [
  "claude-opus-4-1",
  "claude-opus-4-8",
  "claude-sonnet-4",
  "glm-5",
  "gpt-5-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  "gpt-5.5",
  "kimi-k2.5",
  "ling-3.0-flash-free",
  "minimax-m2.5",
  "minimax-m2.7",
] as const;

const REPLACED_BY = new Map([
  ["claude-opus-4-8", "claude-opus-5"],
  ["gpt-5.5", "gpt-5.6-sol"],
  ["minimax-m2.7", "minimax-m3"],
]);

describe("opencode provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("registers only the Zen auth choice from its own provider manifest", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("opencode");
    expect(provider.envVars).toEqual(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]);
    expect(provider.auth.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["opencode-zen"]);
    expect(provider.auth[0]?.wizard).toMatchObject({
      choiceLabel: "OpenCode Zen catalog",
      groupId: "opencode",
      groupHint: "Shared API key infrastructure for Zen + Go",
    });
  });

  it("registers image media understanding through the OpenCode plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });

    const mediaProvider = mediaProviders.find((provider) => provider.id === "opencode");
    if (!mediaProvider) {
      throw new Error("Expected opencode media provider");
    }
    expect(mediaProvider.capabilities).toEqual(["image"]);
    expect(mediaProvider.defaultModels).toEqual({ image: "gpt-5-nano" });
    expect(typeof mediaProvider.describeImage).toBe("function");
    expect(typeof mediaProvider.describeImages).toBe("function");
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "claude-opus-4.6",
    });
  });

  it("keeps OpenCode Zen catalog coverage aligned with the curated seed", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.catalog).toBeDefined();

    const expectedModelIds = [...ACTIVE_MODEL_IDS, ...DEPRECATED_MODEL_IDS];
    expect(new Set(expectedModelIds).size).toBe(expectedModelIds.length);
    const models = new Map<string, ProviderRuntimeModel>();
    for (const modelId of expectedModelIds) {
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected OpenCode Zen model ${modelId}`);
      }
      models.set(model.id, model);
    }
    expect([...models.keys()].toSorted()).toEqual(expectedModelIds.toSorted());

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
    const opus48 = requireCatalogEntry(supplemental, "claude-opus-4-8");
    expect(opus48.provider).toBe("opencode");
    expect(opus48.name).toBe("Claude Opus 4.8");
    for (const modelId of ACTIVE_MODEL_IDS) {
      expect(requireCatalogEntry(supplemental, modelId).status).toBeUndefined();
      expect(requireCatalogEntry(supplemental, modelId).replacedBy).toBeUndefined();
    }
    for (const modelId of DEPRECATED_MODEL_IDS) {
      expect(requireCatalogEntry(supplemental, modelId).status).toBe("deprecated");
      expect(requireCatalogEntry(supplemental, modelId).replacedBy).toBe(REPLACED_BY.get(modelId));
    }

    const opus46 = requireMapEntry(models, "claude-opus-4-6");
    expect(opus46.api).toBe("anthropic-messages");
    expect(opus46.baseUrl).toBe("https://opencode.ai/zen");
    expect(opus46.input).toEqual(["text", "image"]);
    expect(opus46.reasoning).toBe(true);
    expect(opus46.contextWindow).toBe(1_000_000);
    expect(opus46.maxTokens).toBe(128_000);

    expect(requireMapEntry(models, "gpt-5.5")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(requireMapEntry(models, "gpt-5.6-luna")).toMatchObject({
      name: "GPT-5.6 Luna",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
        tieredPricing: [
          { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, range: [0, 272_000] },
          { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5, range: [272_000] },
        ],
      },
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    });
    expect(requireMapEntry(models, "gpt-5.6-terra")).toMatchObject({
      name: "GPT-5.6 Terra",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    });
    expect(requireMapEntry(models, "gpt-5.6-sol")).toMatchObject({
      name: "GPT-5.6 Sol",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    });
    expect(requireMapEntry(models, "gemini-3.5-flash")).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(requireMapEntry(models, "gemini-3.6-flash")).toMatchObject({
      name: "Gemini 3.6 Flash",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
    });
    expect(requireMapEntry(models, "gemini-3.5-flash-lite")).toMatchObject({
      name: "Gemini 3.5 Flash Lite",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
    });
    expect(requireMapEntry(models, "minimax-m2.7")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(requireMapEntry(models, "qwen3.6-plus")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(requireMapEntry(models, "glm-5.2")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    });
    expect(requireMapEntry(models, "claude-sonnet-5")).toMatchObject({
      name: "Claude Sonnet 5",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    });
    expect(requireMapEntry(models, "grok-4.5")).toMatchObject({
      name: "Grok 4.5",
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 500_000,
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.3,
        cacheWrite: 0,
        tieredPricing: [
          { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0, range: [0, 200_000] },
          { input: 4, output: 12, cacheRead: 0.6, cacheWrite: 0, range: [200_000] },
        ],
      },
    });
    expect(requireMapEntry(models, "kimi-k2.7-code")).toMatchObject({
      name: "Kimi K2.7 Code",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 262_144,
      cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
    });
    expect(requireMapEntry(models, "kimi-k3")).toMatchObject({
      name: "Kimi K3",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    });
    expect(requireMapEntry(models, "minimax-m3")).toMatchObject({
      name: "MiniMax M3",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text", "image"],
      contextWindow: 512_000,
      maxTokens: 128_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    });

    const dynamicModel = requireRecord(
      provider.resolveDynamicModel?.({
        modelId: "claude-opus-4-8",
      } as never),
      "dynamic model",
    );
    expect(dynamicModel.id).toBe("claude-opus-4-8");
    expect(dynamicModel.api).toBe("anthropic-messages");
    expect(dynamicModel.provider).toBe("opencode");
    expect(dynamicModel.baseUrl).toBe("https://opencode.ai/zen");
    const compat = requireRecord(dynamicModel.compat, "dynamic model compat");
    expect(compat.supportsUsageInStreaming).toBe(true);
    expect(compat.supportsReasoningEffort).toBe(true);
    expect(compat.maxTokensField).toBe("max_tokens");

    const manifestProvider = requireRecord(
      manifest.modelCatalog.providers.opencode,
      "manifest provider",
    );
    const manifestModels = manifestProvider.models;
    if (!Array.isArray(manifestModels)) {
      throw new Error("expected manifest opencode models");
    }
    const manifestIds = manifestModels.map((model) => requireRecord(model, "manifest model").id);
    expect(new Set(manifestIds).size).toBe(manifestIds.length);
    expect(manifestIds).toEqual([
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-4",
      "gpt-5.6-sol",
      "gpt-5.5",
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "minimax-m3",
      "minimax-m2.7",
      "kimi-k3",
      "big-pickle",
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "laguna-s-2.1-free",
      "ling-3.0-flash-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
      "ling-3.0-tiny-free",
      "longcat-2.0-free",
    ]);
    const manifestClaude48 = requireRecord(
      manifestModels.find(
        (model) => requireRecord(model, "manifest model").id === "claude-opus-4-8",
      ),
      "manifest claude-opus-4-8",
    );
    expect(manifestClaude48).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      status: "deprecated",
      replacedBy: "claude-opus-5",
    });
    const manifestGpt55 = requireRecord(
      manifestModels.find((model) => requireRecord(model, "manifest model").id === "gpt-5.5"),
      "manifest gpt-5.5",
    );
    expect(manifestGpt55).toMatchObject({
      contextWindow: 1_050_000,
      status: "deprecated",
      replacedBy: "gpt-5.6-sol",
    });
    const manifestMiniMax = requireRecord(
      manifestModels.find((model) => requireRecord(model, "manifest model").id === "minimax-m2.7"),
      "manifest minimax-m2.7",
    );
    expect(manifestMiniMax.api).toBe("openai-completions");
    expect(manifestMiniMax.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(manifestMiniMax).toMatchObject({
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
      status: "deprecated",
      replacedBy: "minimax-m3",
    });
    const manifestKimiK3 = requireRecord(
      manifestModels.find((model) => requireRecord(model, "manifest model").id === "kimi-k3"),
      "manifest kimi-k3",
    );
    expect(manifestKimiK3).toMatchObject({
      name: "Kimi K3",
      api: "openai-completions",
      provider: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    });
  });

  it("keeps documented OpenCode Zen example models resolvable", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const docs = readFileSync("docs/providers/opencode.md", "utf8");
    const exampleRow = docs.match(/^\| Example models\s+\| (?<examples>.+) \|$/m);
    if (!exampleRow?.groups?.examples) {
      throw new Error("expected OpenCode Zen example model row");
    }

    const exampleModelRefs = [...exampleRow.groups.examples.matchAll(/`opencode\/(.*?)`/g)].map(
      (match) => match[1],
    );
    expect(exampleModelRefs.length).toBeGreaterThan(0);

    for (const modelId of exampleModelRefs) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({ id: modelId });
    }
  });

  it("keeps every OpenCode Zen row within the required cost contract", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const manifestProvider = requireRecord(
      manifest.modelCatalog.providers.opencode,
      "manifest provider",
    );
    const manifestModels = manifestProvider.models;
    if (!Array.isArray(manifestModels)) {
      throw new Error("expected manifest opencode models");
    }
    const supplemental = await provider.augmentModelCatalog?.({ entries: [] } as never);

    for (const manifestModel of manifestModels) {
      const manifestModelRecord = requireRecord(manifestModel, "manifest model");
      const modelId = manifestModelRecord.id;
      if (typeof modelId !== "string") {
        throw new Error("expected manifest model id");
      }
      requireRecord(manifestModelRecord.cost, `manifest cost ${modelId}`);
      const runtimeModel = requireRecord(
        provider.resolveDynamicModel?.({ modelId } as never),
        `runtime model ${modelId}`,
      );
      requireRecord(runtimeModel.cost, `runtime cost ${modelId}`);
    }

    const verifiedCostExamples = new Map([
      ["claude-fable-5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
      ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
      ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
      [
        "gpt-5.6-luna",
        {
          input: 0.2,
          output: 1.2,
          cacheRead: 0.02,
          cacheWrite: 0.25,
          tieredPricing: [
            { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, range: [0, 272_000] },
            { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5, range: [272_000] },
          ],
        },
      ],
      [
        "gpt-5.6-terra",
        {
          input: 2,
          output: 12,
          cacheRead: 0.2,
          cacheWrite: 2.5,
          tieredPricing: [
            {
              input: 2,
              output: 12,
              cacheRead: 0.2,
              cacheWrite: 2.5,
              range: [0, 272_000],
            },
            {
              input: 4,
              output: 18,
              cacheRead: 0.4,
              cacheWrite: 5,
              range: [272_000],
            },
          ],
        },
      ],
      [
        "gpt-5.6-sol",
        {
          input: 5,
          output: 30,
          cacheRead: 0.5,
          cacheWrite: 6.25,
          tieredPricing: [
            { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, range: [0, 272_000] },
            { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5, range: [272_000] },
          ],
        },
      ],
      ["gpt-5.4-mini", { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 }],
      ["glm-5.2", { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }],
      ["kimi-k2.7-code", { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 }],
      ["kimi-k3", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }],
      ["laguna-s-2.1-free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["ling-3.0-flash-free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["minimax-m2.5", { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }],
      ["minimax-m2.7", { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }],
      ["minimax-m3", { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 }],
    ] as const);

    for (const [modelId, expectedCost] of verifiedCostExamples) {
      const verifiedCostModel = requireRecord(
        provider.resolveDynamicModel?.({ modelId } as never),
        `verified cost model ${modelId}`,
      );
      expect(verifiedCostModel.cost).toEqual(expectedCost);
    }

    for (const manifestModel of manifestModels) {
      const manifestModelRecord = requireRecord(manifestModel, "manifest model");
      const modelId = manifestModelRecord.id;
      if (typeof modelId !== "string") {
        throw new Error("expected manifest model id");
      }
      const runtimeModel = requireRecord(
        provider.resolveDynamicModel?.({ modelId } as never),
        `runtime manifest anchor ${modelId}`,
      );
      const lifecycleEntry = requireCatalogEntry(supplemental, modelId);
      expect({
        api: manifestModelRecord.api ?? manifestProvider.api,
        baseUrl: manifestModelRecord.baseUrl ?? manifestProvider.baseUrl,
        reasoning: manifestModelRecord.reasoning,
        input: manifestModelRecord.input,
        cost: manifestModelRecord.cost,
        contextWindow: manifestModelRecord.contextWindow,
        contextTokens: manifestModelRecord.contextTokens,
        maxTokens: manifestModelRecord.maxTokens,
        thinkingLevelMap: manifestModelRecord.thinkingLevelMap,
        compat: runtimeCompatFields(manifestModelRecord.compat),
        status: manifestModelRecord.status,
        replacedBy: manifestModelRecord.replacedBy,
      }).toEqual({
        api: runtimeModel.api,
        baseUrl: runtimeModel.baseUrl,
        reasoning: runtimeModel.reasoning,
        input: runtimeModel.input,
        cost: runtimeModel.cost,
        contextWindow: runtimeModel.contextWindow,
        contextTokens: runtimeModel.contextTokens,
        maxTokens: runtimeModel.maxTokens,
        thinkingLevelMap: runtimeModel.thinkingLevelMap,
        compat: runtimeCompatFields(runtimeModel.compat),
        status: lifecycleEntry.status,
        replacedBy: lifecycleEntry.replacedBy,
      });
    }
  });

  it("loads OpenCode Zen model discovery through the provider runtime", () => {
    expect(manifest.providerCatalogEntry).toBe("./provider-discovery.ts");
    expect(manifest.modelCatalog.discovery.opencode).toBe("runtime");
  });

  it("exposes the complete offline OpenCode Zen catalog through provider discovery", async () => {
    const { default: opencodeProviderDiscovery } = await import("./provider-discovery.js");
    const result = await opencodeProviderDiscovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Zen static provider");
    }

    const modelIds = result.provider.models.map((model) => model.id);
    expect(new Set(modelIds).size).toBe(modelIds.length);
    expect(modelIds).toEqual(ACTIVE_MODEL_IDS);
  });

  it("exposes the offline catalog fallback through the full provider registration", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected registered OpenCode Zen static provider");
    }

    expect(result.provider.models.map((model) => model.id)).toEqual(ACTIVE_MODEL_IDS);
    expect(result.provider.models.find((model) => model.id === "grok-4.5")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://opencode.ai/zen/v1",
      provider: "opencode",
    });
  });

  it("skips live OpenCode Zen catalog discovery when no shared key is configured", async () => {
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

  it("does not mix provider-specific runtime auth with shared discovery auth", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("blocked fetch"));

    try {
      const result = await provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: (providerId: string) =>
          providerId === "opencode"
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
        throw new Error("expected OpenCode Zen provider result");
      }
      expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(result.provider.models.map((model) => model.id)).toContain("claude-opus-4-7");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses cached live OpenCode Zen discovery and filters live-only rows", async () => {
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({
          data: [
            { id: "kimi-k3", object: "model" },
            { id: "claude-opus-4-7", object: "model" },
            { id: "claude-opus-4-8", object: "model" },
            { id: "claude-sonnet-4", object: "model" },
            { id: "gpt-5.5", object: "model" },
            { id: "minimax-m2.7", object: "model" },
            { id: "ling-3.0-flash-free", object: "model" },
            { id: "gpt-6-experimental", object: "model" },
          ],
        }),
      ),
      finalUrl: "https://opencode.ai/zen/v1/models",
      release: vi.fn(async () => undefined),
    }));

    const first = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    const second = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(first.apiKey).toBe("OPENCODE_API_KEY");
    expect(first.models.map((model) => model.id)).toEqual(["kimi-k3", "claude-opus-4-7"]);
    expect(second.models.map((model) => model.id)).toEqual(["kimi-k3", "claude-opus-4-7"]);
    expect(first.models.find((model) => model.id === "kimi-k3")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
    });
    const claudeModel = first.models.find((model) => model.id === "claude-opus-4-7");
    expect(claudeModel).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
      provider: "opencode",
    });
    const liveOnlyModel = first.models.find((model) => model.id === "gpt-6-experimental");
    expect(liveOnlyModel).toBeUndefined();

    clearLiveCatalogCacheForTests();
    fetchGuard.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          data: [{ id: "gpt-6-experimental", object: "model" }],
        }),
      ),
      finalUrl: "https://opencode.ai/zen/v1/models",
      release: vi.fn(async () => undefined),
    });
    const unknownOnly = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(unknownOnly.models.map((model) => model.id)).toEqual(ACTIVE_MODEL_IDS);

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(fallback.apiKey).toBe("OPENCODE_API_KEY");
    expect(fallback.models.map((model) => model.id)).toEqual(ACTIVE_MODEL_IDS);
  });

  it("keeps live OpenCode Zen discovery caches scoped to discovery credentials", async () => {
    const fetchGuard = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-7", object: "model" }] }),
        ),
        finalUrl: "https://opencode.ai/zen/v1/models",
        release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] })),
        finalUrl: "https://opencode.ai/zen/v1/models",
        release: vi.fn(async () => undefined),
      });

    const first = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-a",
      discoveryApiKey: "discovery-a",
      fetchGuard,
    });
    const second = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-b",
      discoveryApiKey: "discovery-b",
      fetchGuard,
    });
    const secondCached = await buildOpencodeZenLiveProviderConfig({
      apiKey: "runtime-c",
      discoveryApiKey: "discovery-b",
      fetchGuard,
    });

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(first.apiKey).toBe("runtime-a");
    expect(first.models.map((model) => model.id)).toEqual(["claude-opus-4-7"]);
    expect(second.apiKey).toBe("runtime-b");
    expect(second.models.map((model) => model.id)).toEqual(["gpt-5.6-luna"]);
    expect(secondCached.apiKey).toBe("runtime-c");
    expect(secondCached.models.map((model) => model.id)).toEqual(["gpt-5.6-luna"]);
  });

  it.each([
    [["claude-opus-5"], "opencode/claude-opus-5"],
    [["gpt-5.6-sol"], undefined],
  ])("selects only the advertised preferred onboarding model %#", async (modelIds, expected) => {
    const fetchGuard = vi.fn(async () => ({
      response: new Response(
        JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }),
      ),
      finalUrl: "https://opencode.ai/zen/v1/models",
      release: vi.fn(async () => undefined),
    }));

    await expect(
      resolveOpencodeZenStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode/claude-opus-5",
        fetchGuard,
      }),
    ).resolves.toBe(expected);
  });

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
      providerId: "opencode",
      modelId: "kimi-k3",
      thinkingLevel,
    } as never);

    await streamFn?.(
      { provider: "opencode", id: "kimi-k3", api: "openai-completions" } as never,
      {} as never,
      {},
    );
    expect(capturedPayloads).toEqual([
      expectedEffort === undefined
        ? { model: "kimi-k3" }
        : { model: "kimi-k3", reasoning_effort: expectedEffort },
    ]);
  });

  it("canonicalizes stale OpenCode Zen base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode",
        model: {
          provider: "opencode",
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          api: "anthropic-messages",
          baseUrl: "https://opencode.ai/zen/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 65_536,
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen");

    expect(
      provider.normalizeTransport?.({
        provider: "opencode",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(
      provider.normalizeTransport?.({
        provider: "opencode",
        api: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/v1",
      } as never),
    ).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
  });

  it("exposes provider-owned thinking levels for proxied models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const provider = requireRegisteredProvider(providers, "opencode");
    const resolveThinkingProfile = provider.resolveThinkingProfile;
    if (!resolveThinkingProfile) {
      throw new Error("Expected OpenCode provider resolveThinkingProfile");
    }

    const opus47Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4-7",
    });
    const opus47LevelIds = opus47Profile?.levels.map((level) => level.id) ?? [];
    expect(opus47Profile?.defaultLevel).toBe("off");
    expect(opus47LevelIds).toContain("xhigh");
    expect(opus47LevelIds).toContain("adaptive");
    expect(opus47LevelIds).toContain("max");
    const opus46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4.6",
    });
    const opus46LevelIds = opus46Profile?.levels.map((level) => level.id) ?? [];
    expect(opus46Profile?.defaultLevel).toBe("adaptive");
    expect(opus46LevelIds).toContain("adaptive");
    expect(opus46LevelIds).not.toContain("xhigh");
    expect(opus46LevelIds).not.toContain("max");
    const sonnet46Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-sonnet-4-6",
    });
    const sonnet46LevelIds = sonnet46Profile?.levels.map((level) => level.id) ?? [];
    expect(sonnet46Profile?.defaultLevel).toBe("adaptive");
    expect(sonnet46LevelIds).toContain("adaptive");
    expect(sonnet46LevelIds).not.toContain("xhigh");
    expect(sonnet46LevelIds).not.toContain("max");

    const gpt56Profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "gpt-5.6-luna",
      api: "openai-responses",
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    });
    const gpt56LevelIds = gpt56Profile?.levels.map((level) => level.id) ?? [];
    expect(gpt56Profile?.defaultLevel).toBe("medium");
    expect(gpt56LevelIds).not.toContain("minimal");
    expect(gpt56LevelIds).toContain("xhigh");
    expect(gpt56LevelIds).toContain("max");

    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "kimi-k3",
        api: "openai-completions",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["max"] },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "max" }], defaultLevel: "off" });
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "grok-4.5",
        api: "openai-responses",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "big-pickle",
        api: "openai-completions",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off", label: "always on" }], defaultLevel: "off" });
  });
});
