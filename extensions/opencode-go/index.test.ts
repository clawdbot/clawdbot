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

const ACTIVE_MODEL_IDS = manifest.modelCatalog.providers["opencode-go"].models
  .filter((model) => !("status" in model))
  .map((model) => model.id);

function upstreamModel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"] },
    limit: { context: 262_144, output: 32_768 },
    cost: { input: 0, output: 0 },
    ...overrides,
  };
}

function createCatalogFetchGuard(params: {
  upstreamModels: Record<string, unknown>;
  liveModelIds: string[] | (() => string[]);
}) {
  return vi.fn(async ({ url }: { url: string }) => ({
    response: new Response(
      JSON.stringify(
        url === "https://models.opencode.ai/api.json"
          ? {
              "opencode-go": {
                id: "opencode-go",
                api: "https://opencode.ai/zen/go/v1",
                npm: "@ai-sdk/openai-compatible",
                models: params.upstreamModels,
              },
            }
          : {
              data: (typeof params.liveModelIds === "function"
                ? params.liveModelIds()
                : params.liveModelIds
              ).map((id) => ({ id, object: "model" })),
            },
      ),
    ),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  }));
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

  it("keeps offline starter models and provider-owned thinking policies usable", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const supplemental = await provider.augmentModelCatalog?.({ entries: [] } as never);

    for (const modelId of ACTIVE_MODEL_IDS) {
      expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({
        id: modelId,
        provider: "opencode-go",
      });
    }
    expect(requireCatalogEntry(supplemental, "hy3-preview").status).toBe("preview");
    expect(provider.resolveDynamicModel?.({ modelId: "kimi-k2.6" } as never)).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
    });
    expect(provider.resolveDynamicModel?.({ modelId: "qwen3.8-max" } as never)).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      compat: { thinkingFormat: "qwen" },
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
        modelId: "minimax-m2.7",
        api: "anthropic-messages",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "high", label: "always on" }], defaultLevel: "high" });
  });

  it("joins paid-model availability with upstream capabilities and preserves lifecycle", async () => {
    const fetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "ox-alpha-free": upstreamModel("ox-alpha-free", {
          name: "Ox Alpha Free (Unlimited)",
          modalities: { input: ["text", "image", "video"] },
          limit: { context: 1_000_000, output: 131_072 },
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        }),
        "minimax-future": upstreamModel("minimax-future", {
          provider: { npm: "@ai-sdk/anthropic" },
          cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
        }),
        "legacy-model": upstreamModel("legacy-model", { status: "deprecated" }),
      },
      liveModelIds: ["ox-alpha-free", "minimax-future", "legacy-model", "unknown-live-model"],
    });

    const result = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(result.models.map((model) => model.id)).toEqual(["ox-alpha-free", "minimax-future"]);
    expect(result.models[0]).toMatchObject({
      id: "ox-alpha-free",
      name: "Ox Alpha Free (Unlimited)",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: { supportedReasoningEfforts: ["low", "high", "max"], supportsTools: true },
    });
    expect(result.models[1]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    });

    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.resolveDynamicModel?.({ modelId: "legacy-model" } as never)).toBeUndefined();
    const supplemental = await provider.augmentModelCatalog?.({ entries: [] } as never);
    expect(requireCatalogEntry(supplemental, "legacy-model").status).toBe("deprecated");
    expect(requireCatalogEntry(supplemental, "hy3-preview").status).toBe("preview");
  });

  it("never resolves another account's upstream-only Go model outside its authenticated catalog", async () => {
    const upstreamModels = {
      "account-a-only": upstreamModel("account-a-only"),
      "account-b-only": upstreamModel("account-b-only"),
    };
    const accountAFetchGuard = createCatalogFetchGuard({
      upstreamModels,
      liveModelIds: ["account-a-only"],
    });
    const accountA = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "account-a-key",
      fetchGuard: accountAFetchGuard,
    });
    expect(accountA.models.map((model) => model.id)).toEqual(["account-a-only"]);

    const accountBFetchGuard = createCatalogFetchGuard({
      upstreamModels,
      liveModelIds: ["account-b-only"],
    });
    const accountB = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "account-b-key",
      fetchGuard: accountBFetchGuard,
    });
    expect(accountB.models.map((model) => model.id)).toEqual(["account-b-only"]);

    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.resolveDynamicModel?.({ modelId: "account-a-only" } as never)).toBeUndefined();
    expect(provider.resolveDynamicModel?.({ modelId: "account-b-only" } as never)).toBeUndefined();
    expect(provider.prepareDynamicModel).toBeUndefined();
  });

  it("evicts withdrawn or unsafe upstream models while retaining trusted offline seeds", async () => {
    const originalFetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "withdrawn-model": upstreamModel("withdrawn-model"),
      },
      liveModelIds: ["withdrawn-model"],
    });
    await expect(
      buildOpencodeGoLiveProviderConfig({
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard: originalFetchGuard,
      }),
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: "withdrawn-model" })] });

    clearLiveCatalogCacheForTests();
    const refreshedFetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "replacement-model": upstreamModel("replacement-model"),
        "unsafe-model": upstreamModel("unsafe-model", {
          provider: { api: "https://attacker.invalid/v1" },
        }),
      },
      liveModelIds: ["replacement-model", "unsafe-model"],
    });
    await expect(
      buildOpencodeGoLiveProviderConfig({
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard: refreshedFetchGuard,
      }),
    ).resolves.toMatchObject({ models: [expect.objectContaining({ id: "replacement-model" })] });

    const provider = await registerSingleProviderPlugin(plugin);
    const entries = await provider.augmentModelCatalog?.({ entries: [] } as never);
    expect(entries?.some((entry) => entry.id === "withdrawn-model")).toBe(false);
    expect(entries?.some((entry) => entry.id === "unsafe-model")).toBe(false);
    expect(requireCatalogEntry(entries, "hy3-preview").status).toBe("preview");
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

  it("exposes only trusted offline starter models through provider discovery", async () => {
    const result = await opencodeGoProviderDiscovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Go static provider");
    }
    const deepSeekPro = result.provider.models.find((model) => model.id === "deepseek-v4-pro");
    const deepSeekFlash = result.provider.models.find((model) => model.id === "deepseek-v4-flash");
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
    expect(modelIds).not.toContain("hy3-preview");
  });

  it("skips unrelated scoped discovery even when OpenCode credentials are configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const resolveProviderApiKey = vi.fn(() => ({
      apiKey: "configured-opencode-key",
      discoveryApiKey: "configured-opencode-key",
    }));

    try {
      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          providerIds: ["anthropic"],
          resolveProviderApiKey,
        } as never),
      ).resolves.toBeNull();
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          providerIds: ["opencode-go"],
          resolveProviderApiKey: () => ({ apiKey: "configured-opencode-key" }),
        } as never),
      ).resolves.toMatchObject({
        provider: { apiKey: "configured-opencode-key" },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("never fetches either catalog when no shared OpenCode key is configured", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        provider.catalog?.run({
          config: {},
          env: {},
          resolveProviderApiKey: () => ({ apiKey: undefined }),
          resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
        } as never),
      ).resolves.toBeNull();
      await expect(buildOpencodeGoLiveProviderConfig()).resolves.toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: "deepseek-v4-pro" })]),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps the unavailable-upstream preview resolvable but out of advertised catalogs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const staticModelIds = buildStaticOpencodeGoProviderConfig().models.map((model) => model.id);
    const fetchGuard = createCatalogFetchGuard({
      upstreamModels: {
        "deepseek-v4-pro": upstreamModel("deepseek-v4-pro"),
      },
      liveModelIds: ["hy3-preview", "deepseek-v4-pro"],
    });

    expect(staticModelIds.toSorted()).toEqual(ACTIVE_MODEL_IDS.toSorted());
    expect(staticModelIds).not.toContain("hy3-preview");
    expect(provider.resolveDynamicModel?.({ modelId: "hy3-preview" } as never)).toMatchObject({
      id: "hy3-preview",
    });
    const live = await buildOpencodeGoLiveProviderConfig({
      discoveryApiKey: "resolved-opencode-key",
      fetchGuard,
    });

    expect(live.models.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
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
    const resolveProviderApiKey = vi.fn((providerId: string) =>
      providerId === "opencode-go"
        ? { apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: undefined }
        : { apiKey: "shared-opencode-key", discoveryApiKey: "shared-opencode-key" },
    );

    try {
      const result = await provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      } as never);

      if (!result || !("provider" in result)) {
        throw new Error("expected OpenCode Go provider result");
      }
      expect(result.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      expect(result.provider.models.map((model) => model.id)).toContain("deepseek-v4-pro");
      expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("opencode-go");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses Zen credentials for the Go catalog only when Go has no credentials", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const resolveProviderApiKey = vi.fn((providerId?: string) => ({
      apiKey: providerId === "opencode" ? NON_ENV_SECRETREF_MARKER : undefined,
    }));

    await expect(
      provider.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toMatchObject({
      provider: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: NON_ENV_SECRETREF_MARKER,
      },
    });
    expect(resolveProviderApiKey.mock.calls).toEqual([["opencode-go"], ["opencode"]]);
  });

  it("caches both catalog requests without concealing later acquisition failure", async () => {
    const liveIds = ["minimax-m3", "qwen3.7-max", "qwen3.7-plus"];
    const fetchGuard = createCatalogFetchGuard({
      upstreamModels: Object.fromEntries(liveIds.map((id) => [id, upstreamModel(id)])),
      liveModelIds: liveIds,
    });

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

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(first.apiKey).toBe("OPENCODE_API_KEY");
    expect(first.models.map((model) => model.id).toSorted()).toEqual(liveIds);
    expect(second.models.map((model) => model.id).toSorted()).toEqual(liveIds);

    clearLiveCatalogCacheForTests();
    fetchGuard.mockRejectedValue(new Error("network unavailable"));
    await expect(
      buildOpencodeGoLiveProviderConfig({
        apiKey: "OPENCODE_API_KEY",
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard,
      }),
    ).rejects.toThrow("network unavailable");
  });

  it.each([
    ["retired seed", "failed"],
    ["retired seed", "filtered"],
    ["activated preview", "failed"],
  ] as const)(
    "keeps refreshed %s metadata separate from %s model advertising",
    async (lifecycle, advertising) => {
      const retired = lifecycle === "retired seed";
      const modelId = retired ? "deepseek-v4-pro" : "hy3-preview";
      const provider = await registerSingleProviderPlugin(plugin);
      const fetchGuard = createCatalogFetchGuard({
        upstreamModels: {
          [modelId]: upstreamModel(modelId, retired ? { status: "deprecated" } : {}),
        },
        liveModelIds: () => {
          if (advertising === "failed") {
            throw new Error("model advertising unavailable");
          }
          return [modelId];
        },
      });

      try {
        expect(buildStaticOpencodeGoProviderConfig().models.map((model) => model.id)).toEqual(
          ACTIVE_MODEL_IDS,
        );
        const discovery = buildOpencodeGoLiveProviderConfig({
          apiKey: "runtime-key",
          discoveryApiKey: "discovery-key",
          fetchGuard,
        });

        if (advertising === "failed") {
          await expect(discovery).rejects.toThrow("model advertising unavailable");
        } else {
          await expect(discovery).resolves.toMatchObject({ models: [] });
        }
        expect(provider.resolveDynamicModel?.({ modelId } as never)).toMatchObject({
          id: modelId,
        });
      } finally {
        clearLiveCatalogCacheForTests();
        await buildOpencodeGoLiveProviderConfig({
          discoveryApiKey: "discovery-key",
          fetchGuard: createCatalogFetchGuard({ upstreamModels: {}, liveModelIds: [] }),
        });
        clearLiveCatalogCacheForTests();
      }
    },
  );

  it("does not synthesize a stream when the runtime provides none", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.wrapStreamFn?.({ streamFn: undefined } as never)).toBeUndefined();
  });

  it("identifies native Anthropic stream and simple requests without tagging proxies", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const testCase of [
      {
        wrap: provider.wrapStreamFn,
        runtimeApi: "anthropic-messages",
        sourceApi: undefined,
      },
      {
        wrap: provider.wrapSimpleCompletionStreamFn,
        runtimeApi: "openclaw-provider-simple:opencode-go:qwen3.8-max",
        sourceApi: "anthropic-messages",
      },
    ] as const) {
      const capturedHeaders: Array<Record<string, string> | undefined> = [];
      const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
        capturedHeaders.push((options as { headers?: Record<string, string> })?.headers);
        return {} as never;
      };
      const streamFn = testCase.wrap?.({
        streamFn: baseStreamFn as never,
        providerId: "opencode-go",
        modelId: "qwen3.8-max",
        thinkingLevel: "high",
        sourceApi: testCase.sourceApi,
      } as never);

      expect(streamFn).toBeTypeOf("function");
      await streamFn?.(
        {
          provider: "opencode-go",
          id: "qwen3.8-max",
          api: testCase.runtimeApi,
          baseUrl: "https://opencode.ai/zen/go",
        } as never,
        {} as never,
        { headers: { "User-Agent": "configured-client/1.0", "X-Custom": "1" } },
      );
      await streamFn?.(
        {
          provider: "opencode-go",
          id: "qwen3.8-max",
          api: testCase.runtimeApi,
          baseUrl: "https://proxy.example.com",
        } as never,
        {} as never,
        { headers: { "User-Agent": "configured-client/2.0", "X-Custom": "2" } },
      );

      expect(capturedHeaders).toEqual([
        {
          "User-Agent": expect.stringMatching(/^openclaw\//),
          "X-Custom": "1",
        },
        { "User-Agent": "configured-client/2.0", "X-Custom": "2" },
      ]);
    }
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
    ["glm-5.2", "max", undefined, ["high", "max"]],
    ["grok-4.5", "high", undefined, ["low", "medium", "high"]],
    ["hy3", "low", "none", ["none", "low", "high"]],
  ] as const)(
    "maps %s only to supported wire efforts",
    async (modelId, enabledEffort, offEffort, efforts) => {
      const fetchGuard = createCatalogFetchGuard({
        upstreamModels: {
          [modelId]: upstreamModel(modelId, {
            reasoning_options: [{ type: "effort", values: efforts }],
          }),
        },
        liveModelIds: [modelId],
      });
      const live = await buildOpencodeGoLiveProviderConfig({
        discoveryApiKey: "resolved-opencode-key",
        fetchGuard,
      });
      const model = live.models.find((candidate) => candidate.id === modelId);
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
