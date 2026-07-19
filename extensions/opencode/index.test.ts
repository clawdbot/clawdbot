// Opencode tests cover index plugin behavior.
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildOpencodeZenLiveProviderConfig } from "./provider-catalog.js";

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

describe("opencode provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
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

    const expectedModelIds = [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-haiku-4-5",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex-spark",
      "gpt-5.3-codex",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.1",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-nano",
      "grok-build-0.1",
      "grok-4.5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "big-pickle",
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "hy3-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
    ];
    const models = new Map<string, ProviderRuntimeModel>();
    for (const modelId of expectedModelIds) {
      const model = provider.resolveDynamicModel?.({ modelId } as never);
      if (!model) {
        throw new Error(`expected OpenCode Zen model ${modelId}`);
      }
      models.set(model.id, model);
    }
    expect([...models.keys()]).toEqual(expectedModelIds);

    const supplemental = await provider.augmentModelCatalog?.({
      entries: [...models.values()].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      })),
    } as never);
    const opus48 = requireCatalogEntry(supplemental, "claude-opus-4-8");
    expect(opus48.provider).toBe("opencode");
    expect(opus48.name).toBe("Claude Opus 4.8");

    const opus46 = requireMapEntry(models, "claude-opus-4-6");
    expect(opus46.api).toBe("anthropic-messages");
    expect(opus46.baseUrl).toBe("https://opencode.ai/zen");
    expect(opus46.input).toEqual(["text", "image"]);
    expect(opus46.reasoning).toBe(true);
    expect(opus46.contextWindow).toBe(200_000);
    expect(opus46.maxTokens).toBe(65_536);

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
        input: 1,
        output: 6,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        tieredPricing: [
          { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25, range: [0, 272_000] },
          { input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5, range: [272_000] },
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
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
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
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
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
    expect(requireMapEntry(models, "hy3-free")).toMatchObject({
      name: "Hy3 Free",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      input: ["text"],
      contextWindow: 256_000,
      maxTokens: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    expect(manifestModels.map((model) => requireRecord(model, "manifest model").id)).toEqual([
      "claude-opus-4-8",
      "gpt-5.5",
      "gemini-3.1-pro",
      "minimax-m2.7",
    ]);
    const manifestMiniMax = requireRecord(
      manifestModels.find((model) => requireRecord(model, "manifest model").id === "minimax-m2.7"),
      "manifest minimax-m2.7",
    );
    expect(manifestMiniMax.api).toBe("openai-completions");
    expect(manifestMiniMax.baseUrl).toBe("https://opencode.ai/zen/v1");
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
      ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
      ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
      ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
      [
        "gpt-5.6-luna",
        {
          input: 1,
          output: 6,
          cacheRead: 0.1,
          cacheWrite: 1.25,
          tieredPricing: [
            { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25, range: [0, 272_000] },
            { input: 2, output: 9, cacheRead: 0.2, cacheWrite: 2.5, range: [272_000] },
          ],
        },
      ],
      [
        "gpt-5.6-terra",
        {
          input: 2.5,
          output: 15,
          cacheRead: 0.25,
          cacheWrite: 3.125,
          tieredPricing: [
            {
              input: 2.5,
              output: 15,
              cacheRead: 0.25,
              cacheWrite: 3.125,
              range: [0, 272_000],
            },
            {
              input: 5,
              output: 22.5,
              cacheRead: 0.5,
              cacheWrite: 6.25,
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
      ["hy3-free", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      ["kimi-k2.7-code", { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 }],
      ["minimax-m2.7", { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 }],
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
      expect(manifestModelRecord.cost).toEqual(runtimeModel.cost);
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

    expect(result.provider.models).toHaveLength(55);
    expect(result.provider.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(result.provider.models.map((model) => model.id)).toContain("claude-sonnet-5");
    expect(result.provider.models.map((model) => model.id)).toContain("glm-5.2");
    expect(result.provider.models.map((model) => model.id)).toContain("grok-4.5");
    expect(result.provider.models.map((model) => model.id)).toContain("hy3-free");
    expect(result.provider.models.map((model) => model.id)).toContain("kimi-k2.7-code");
    expect(result.provider.models.map((model) => model.id)).toContain("minimax-m2.7");
    expect(result.provider.models.map((model) => model.id)).toContain("minimax-m3");
    expect(result.provider.models.map((model) => model.id)).toContain("gpt-5.6-luna");
    expect(result.provider.models.find((model) => model.id === "minimax-m2.7")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      provider: "opencode",
    });
  });

  it("exposes the offline catalog fallback through the full provider registration", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const result = await provider.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected registered OpenCode Zen static provider");
    }

    expect(result.provider.models).toHaveLength(55);
    expect(result.provider.models.map((model) => model.id)).toContain("claude-sonnet-5");
    expect(result.provider.models.map((model) => model.id)).toContain("gpt-5.6-sol");
    expect(result.provider.models.map((model) => model.id)).toContain("minimax-m3");
    expect(result.provider.models.find((model) => model.id === "grok-4.5")).toMatchObject({
      api: "openai-completions",
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
      expect(result.provider.models.map((model) => model.id)).toContain("claude-opus-4-8");
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
            { id: "claude-opus-4-8", object: "model" },
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
    expect(first.models.map((model) => model.id)).toEqual(["claude-opus-4-8"]);
    expect(second.models.map((model) => model.id)).toEqual(["claude-opus-4-8"]);
    const claudeModel = first.models.find((model) => model.id === "claude-opus-4-8");
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
    expect(unknownOnly.models.map((model) => model.id)).toContain("claude-opus-4-8");

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValueOnce(new Error("network unavailable"));
    const fallback = await buildOpencodeZenLiveProviderConfig({
      apiKey: "OPENCODE_API_KEY",
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });
    expect(fallback.apiKey).toBe("OPENCODE_API_KEY");
    expect(fallback.models.map((model) => model.id)).toContain("claude-opus-4-8");
    expect(fallback.models.map((model) => model.id)).toContain("claude-opus-4-6");
  });

  it("keeps live OpenCode Zen discovery caches scoped to discovery credentials", async () => {
    const fetchGuard = vi
      .fn()
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-8", object: "model" }] }),
        ),
        finalUrl: "https://opencode.ai/zen/v1/models",
        release: vi.fn(async () => undefined),
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] })),
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
    expect(first.models.map((model) => model.id)).toEqual(["claude-opus-4-8"]);
    expect(second.apiKey).toBe("runtime-b");
    expect(second.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(secondCached.apiKey).toBe("runtime-c");
    expect(secondCached.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
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
  });
});
