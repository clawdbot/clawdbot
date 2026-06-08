// Opencode Go tests cover index plugin behavior.
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
import { buildOpencodeGoLiveProviderConfig } from "./provider-catalog.js";

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

describe("opencode-go provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
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
      "hy3-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "mimo-v2-omni",
      "mimo-v2.5",
      "mimo-v2-pro",
      "mimo-v2.5-pro",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
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

    const kimi = requireMapEntry(models, "kimi-k2.6");
    expect(kimi.api).toBe("openai-completions");
    expect(kimi.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(kimi.input).toEqual(["text", "image"]);
    expect(kimi.reasoning).toBe(true);
    expect(kimi.contextWindow).toBe(262_144);
    expect(kimi.maxTokens).toBe(65_536);

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
    expect(minimaxM3.contextWindow).toBe(204_800);
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

  it("loads OpenCode Go model discovery through the provider runtime", () => {
    expect(manifest.modelCatalog.discovery["opencode-go"]).toBe("runtime");
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

  it("disables invalid DeepSeek V4 reasoning_effort off payloads on OpenCode Go", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "deepseek-v4-flash",
        reasoning_effort: "off",
        reasoning: "off",
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
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
        thinking: { type: "disabled" },
      },
    ]);
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
          id: "kimi-k2.6",
          name: "Kimi K2.6",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/go/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 65_536,
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
