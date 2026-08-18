// Covers context-token lookup caches, catalog warmup, and provider-qualified
// model resolution.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceDiscoveredContextTokenCache } from "./context-cache.js";
import { ANTHROPIC_CONTEXT_1M_TOKENS } from "./context-resolution.js";
import { CONTEXT_WINDOW_RUNTIME_STATE } from "./context-runtime-state.js";

type DiscoveredModel = {
  id: string;
  provider?: string;
  contextWindow?: number;
  contextTokens?: number;
};
type ContextModule = typeof import("./context.js");

const contextTestState = vi.hoisted(() => {
  const state = {
    loadConfigImpl: () => ({}) as unknown,
    discoveredModels: [] as DiscoveredModel[],
    staticCatalogModels: [] as DiscoveredModel[],
    runtimeConfigSnapshot: null as OpenClawConfig | null,
    runtimeConfigSourceSnapshot: null as OpenClawConfig | null,
    loadModelCatalogOwnerSnapshot: vi.fn(async (_params: unknown) => ({
      modelCatalog: {
        entries: state.discoveredModels,
        routeVariants: [],
        staticEntries: state.staticCatalogModels,
      },
    })),
    getPublishedModelCatalogOwnerSnapshot: vi.fn(
      (
        _params: unknown,
      ):
        | {
            config: OpenClawConfig;
            modelCatalog: {
              entries: DiscoveredModel[];
              routeVariants: never[];
              staticEntries: DiscoveredModel[];
            };
          }
        | undefined => ({
        config: state.loadConfigImpl() as OpenClawConfig,
        modelCatalog: {
          entries: state.discoveredModels,
          routeVariants: [],
          staticEntries: state.staticCatalogModels,
        },
      }),
    ),
  };
  return state;
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => contextTestState.loadConfigImpl(),
}));

vi.mock("../config/runtime-source-projection.js", () => ({
  projectConfigOntoRuntimeSourceSnapshot: (config: OpenClawConfig) =>
    contextTestState.runtimeConfigSnapshot && contextTestState.runtimeConfigSourceSnapshot
      ? contextTestState.runtimeConfigSourceSnapshot
      : config,
}));

vi.mock("./prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: contextTestState.loadModelCatalogOwnerSnapshot,
  getPublishedPreparedModelCatalogOwnerSnapshot:
    contextTestState.getPublishedModelCatalogOwnerSnapshot,
}));

function mockContextDeps(params: {
  getRuntimeConfig: () => unknown;
  discoveredModels?: DiscoveredModel[];
}) {
  // The context module keeps process-local cache state, so tests replace the
  // dependency seams before asking the already-imported module for values.
  contextTestState.loadConfigImpl = params.getRuntimeConfig;
  contextTestState.discoveredModels = params.discoveredModels ?? [];
}

function mockContextModuleDeps(loadConfigImpl: () => unknown) {
  return mockContextDeps({ getRuntimeConfig: loadConfigImpl });
}

// Shared mock setup used by multiple tests.
function mockDiscoveryDeps(
  models: DiscoveredModel[],
  configModels?: Record<string, { models: Array<{ id: string; contextWindow: number }> }>,
) {
  mockContextDeps({
    getRuntimeConfig: () => ({ models: configModels ? { providers: configModels } : {} }),
    discoveredModels: models,
  });
}

function createContextOverrideConfig(
  provider: string,
  model: string,
  contextWindow: number,
): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://example.invalid",
          models: [{ id: model, contextWindow } as never],
        },
      },
    },
  };
}

async function flushAsyncWarmup() {
  // Warmup may run via timers or microtasks depending on the import path; flush
  // both so assertions observe stable cache state.
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await Promise.resolve();
}

let contextModule: ContextModule;

async function importContextModule(): Promise<ContextModule> {
  await flushAsyncWarmup();
  return contextModule;
}

async function importFreshContextModule(): Promise<ContextModule> {
  vi.resetModules();
  const module = await import("./context.js");
  await flushAsyncWarmup();
  return module;
}

async function importResolveContextTokensForModel() {
  const { resolveContextTokensForModel } = await importContextModule();
  return resolveContextTokensForModel;
}

describe("lookupContextTokens", () => {
  beforeAll(async () => {
    contextModule = await importFreshContextModule();
  });

  beforeEach(() => {
    contextTestState.loadConfigImpl = () => ({});
    contextTestState.discoveredModels = [];
    contextTestState.staticCatalogModels = [];
    contextTestState.runtimeConfigSnapshot = null;
    contextTestState.runtimeConfigSourceSnapshot = null;
    contextTestState.loadModelCatalogOwnerSnapshot.mockClear();
    contextTestState.loadModelCatalogOwnerSnapshot.mockImplementation(async () => ({
      modelCatalog: {
        entries: contextTestState.discoveredModels,
        routeVariants: [],
        staticEntries: contextTestState.staticCatalogModels,
      },
    }));
    contextTestState.getPublishedModelCatalogOwnerSnapshot.mockClear();
    contextTestState.getPublishedModelCatalogOwnerSnapshot.mockImplementation(() => ({
      config: contextTestState.loadConfigImpl() as OpenClawConfig,
      modelCatalog: {
        entries: contextTestState.discoveredModels,
        routeVariants: [],
        staticEntries: contextTestState.staticCatalogModels,
      },
    }));
    contextModule.resetContextWindowCacheForTest();
  });

  afterEach(async () => {
    contextModule.resetContextWindowCacheForTest();
    await flushAsyncWarmup();
  });

  it("returns configured model context window on first lookup", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(321_000);
  });

  it("returns sync config overrides for read-only callers", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
  });

  it("prefers config contextTokens over contextWindow on first lookup", async () => {
    mockContextModuleDeps(() => ({
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("gpt-5.4", { allowAsyncLoad: false })).toBe(272_000);
  });

  it("keeps a lower configured window as a cap on discovered context tokens", async () => {
    mockDiscoveryDeps([{ provider: "openai", id: "gpt-5.5", contextTokens: 272_000 }], {
      openai: {
        models: [{ id: "gpt-5.5", contextWindow: 128_000 }],
      },
    });

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("gpt-5.5");
    await flushAsyncWarmup();

    expect(lookupContextTokens("gpt-5.5")).toBe(128_000);
  });

  it("rehydrates config-backed cache entries after module reload when runtime config survives", async () => {
    // The shared runtime snapshot should survive module reloads so lookups do
    // not synchronously reread config on every import.
    const firstLoadConfigMock = vi.fn(() => ({
      models: {
        providers: {
          openrouter: {
            models: [{ id: "openrouter/claude-sonnet", contextWindow: 321_000 }],
          },
        },
      },
    }));
    mockContextModuleDeps(firstLoadConfigMock);

    let { lookupContextTokens } = await importFreshContextModule();
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
    expect(firstLoadConfigMock).toHaveBeenCalledTimes(1);

    vi.resetModules();

    const secondLoadConfigMock = vi.fn(() => {
      throw new Error("config should come from shared runtime state");
    });
    mockContextModuleDeps(secondLoadConfigMock);

    ({ lookupContextTokens } = await importFreshContextModule());
    expect(lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
    expect(secondLoadConfigMock).not.toHaveBeenCalled();
  });

  it("retries config loading after backoff when an initial load fails", async () => {
    vi.useFakeTimers();
    const loadConfigMock = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("transient");
      })
      .mockImplementation(() => ({
        models: {
          providers: {
            openrouter: {
              models: [{ id: "openrouter/claude-sonnet", contextWindow: 654_321 }],
            },
          },
        },
      }));

    mockContextModuleDeps(loadConfigMock);

    try {
      const { lookupContextTokens } = await importContextModule();
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
      expect(loadConfigMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lookupContextTokens("openrouter/claude-sonnet")).toBe(654_321);
      expect(loadConfigMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a configured token override before refreshing discovery", async () => {
    mockContextDeps({
      getRuntimeConfig: () => ({
        models: {
          providers: {
            openrouter: {
              models: [
                {
                  id: "claude-sonnet",
                  contextWindow: 321_000,
                  contextTokens: 111_000,
                },
              ],
            },
          },
        },
      }),
      discoveredModels: [{ provider: "openrouter", id: "claude-sonnet", contextWindow: 654_321 }],
    });

    const { lookupContextTokens, refreshContextWindowCache } = await importContextModule();
    expect(lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(111_000);

    const nextConfig = createContextOverrideConfig("openrouter", "claude-sonnet", 222_000);
    contextTestState.discoveredModels = [
      { provider: "openrouter", id: "claude-sonnet", contextWindow: 222_000 },
    ];
    const refreshPromise = refreshContextWindowCache(nextConfig);
    expect(lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
    await refreshPromise;

    expect(lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
  });

  it("returns the smaller window when the same bare model id is discovered under multiple providers", async () => {
    // Bare model ids are ambiguous across providers; the conservative minimum
    // prevents over-budget prompts when callers lack provider context.
    mockDiscoveryDeps([
      { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
    ]);

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("gemini-3.1-pro-preview");
    await flushAsyncWarmup();
    // Conservative minimum: bare-id cache feeds runtime flush/compaction paths.
    expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("loads the read-only catalog during warmup and preserves provider-owned context metadata", async () => {
    const config = {
      agents: { defaults: { workspace: "/tmp/context-catalog-workspace" } },
    } as OpenClawConfig;
    mockDiscoveryDeps([
      {
        id: "anthropic/claude-opus-4.7-20260219",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ]);
    contextTestState.loadConfigImpl = () => config;

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("anthropic/claude-opus-4.7-20260219");
    await flushAsyncWarmup();

    expect(contextTestState.loadModelCatalogOwnerSnapshot).toHaveBeenCalledOnce();
    expect(contextTestState.loadModelCatalogOwnerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        agentDir: expect.any(String),
        readOnly: true,
      }),
    );
    expect(contextTestState.loadModelCatalogOwnerSnapshot.mock.calls[0]?.[0]).not.toHaveProperty(
      "workspaceDir",
    );
    expect(lookupContextTokens("anthropic/claude-opus-4.7-20260219")).toBe(
      ANTHROPIC_CONTEXT_1M_TOKENS,
    );
  });

  it("keeps ordinary cache loading on the exact owner path", async () => {
    const config = createContextOverrideConfig("anthropic", "claude-opus-4.7-20260219", 200_000);
    mockDiscoveryDeps([
      {
        id: "anthropic/claude-opus-4.7-20260219",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ]);

    const { ensureContextWindowCacheLoaded, lookupContextTokens } = await importContextModule();
    await ensureContextWindowCacheLoaded(config);

    expect(contextTestState.loadModelCatalogOwnerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ config, readOnly: true }),
    );
    expect(contextTestState.getPublishedModelCatalogOwnerSnapshot).not.toHaveBeenCalled();
    expect(
      lookupContextTokens("anthropic/claude-opus-4.7-20260219", { allowAsyncLoad: false }),
    ).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("warms from the current Gateway-published owner without hashing a fallback owner key", async () => {
    const requestedConfig = createContextOverrideConfig("synthetic", "stale-model", 111_000);
    const publishedConfig = createContextOverrideConfig("synthetic", "current-model", 222_000);
    contextTestState.getPublishedModelCatalogOwnerSnapshot.mockReturnValueOnce({
      config: publishedConfig,
      modelCatalog: {
        entries: [{ id: "discovered-model", provider: "synthetic", contextWindow: 64_000 }],
        routeVariants: [],
        staticEntries: [],
      },
    });

    const { lookupContextTokens, prewarmContextWindowCacheAfterReady } =
      await importContextModule();
    await prewarmContextWindowCacheAfterReady({ config: requestedConfig });

    expect(contextTestState.getPublishedModelCatalogOwnerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: requestedConfig,
        allowGatewaySubagentBinding: true,
      }),
    );
    expect(
      contextTestState.getPublishedModelCatalogOwnerSnapshot.mock.calls[0]?.[0],
    ).not.toHaveProperty("readOnly");
    expect(contextTestState.loadModelCatalogOwnerSnapshot).not.toHaveBeenCalled();
    expect(
      lookupContextTokens("current-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBe(222_000);
    expect(
      lookupContextTokens("discovered-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBe(64_000);
    expect(
      lookupContextTokens("stale-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBeUndefined();
  });

  it("retires a failed published-owner load so exact request-time loading can recover", async () => {
    contextTestState.getPublishedModelCatalogOwnerSnapshot.mockReturnValueOnce(undefined);
    const config = createContextOverrideConfig("synthetic", "recovered-model", 96_000);
    contextTestState.loadConfigImpl = () => config;

    const { ensureContextWindowCacheLoaded, prewarmContextWindowCacheAfterReady } =
      await importContextModule();
    await expect(prewarmContextWindowCacheAfterReady({ config })).resolves.toBeUndefined();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig).toBeUndefined();

    await ensureContextWindowCacheLoaded();
    expect(contextTestState.loadModelCatalogOwnerSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ config, readOnly: true }),
    );
  });

  it("retires stale discovered metadata when exact catalog loading fails", async () => {
    replaceDiscoveredContextTokenCache(new Map([["stale-model", 999_000]]));
    contextTestState.loadModelCatalogOwnerSnapshot.mockRejectedValueOnce(
      new Error("catalog unavailable"),
    );

    const { ensureContextWindowCacheLoaded, lookupContextTokens } = await importContextModule();
    await ensureContextWindowCacheLoaded(
      createContextOverrideConfig("synthetic", "current-model", 96_000),
    );

    expect(
      lookupContextTokens("stale-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBeUndefined();
  });

  it("retires an unpublished prewarm marker when shutdown cancels during import", async () => {
    let cancelled = false;
    const pending = contextModule.prewarmContextWindowCacheAfterReady({
      config: {},
      isCancelled: () => cancelled,
    });
    cancelled = true;

    await pending;
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBeNull();
  });

  it("warms fresh caches instead of reusing a pre-generation load promise", async () => {
    const legacyLoadPromise = Promise.resolve();
    CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = legacyLoadPromise;
    CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = null;
    CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = createContextOverrideConfig(
      "fresh-provider",
      "fresh-model",
      123_456,
    );

    await contextModule.ensureContextWindowCacheLoaded();

    expect(
      contextModule.lookupContextTokens("fresh-model", {
        allowAsyncLoad: false,
        skipRuntimeConfigLoad: true,
      }),
    ).toBe(123_456);
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).not.toBe(legacyLoadPromise);
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBe(
      CONTEXT_WINDOW_RUNTIME_STATE.generation,
    );
  });

  it("status waits for pending context warmup but releases on timeout", async () => {
    vi.useFakeTimers();
    try {
      contextTestState.loadModelCatalogOwnerSnapshot.mockImplementationOnce(
        () => new Promise<never>(() => {}),
      );

      const { ensureContextWindowCacheLoaded, waitForContextWindowCacheLoad } =
        await importContextModule();
      void ensureContextWindowCacheLoaded(
        createContextOverrideConfig("anthropic", "claude", 200_000),
      );

      const waitResult = waitForContextWindowCacheLoad({ timeoutMs: 5 });
      await vi.advanceTimersByTimeAsync(5);

      await expect(waitResult).resolves.toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("warms context metadata from bundled provider static catalogs", async () => {
    contextTestState.staticCatalogModels = [
      {
        id: "gemini-3.1-pro-preview",
        provider: "google",
        contextWindow: 1_048_576,
      },
    ];

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    expect(lookupContextTokens("gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("keeps discovered context metadata when no static rows exist", async () => {
    mockDiscoveryDeps([
      {
        id: "claude-sonnet",
        provider: "openrouter",
        contextWindow: 654_321,
      },
    ]);
    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("claude-sonnet");
    await flushAsyncWarmup();

    expect(lookupContextTokens("claude-sonnet")).toBe(654_321);
  });

  it("resolveContextTokensForModel handles self-prefixed provider-owned discovery ids", async () => {
    mockDiscoveryDeps([
      {
        provider: "github-copilot",
        id: "github-copilot/gemini-3.1-pro-preview",
        contextWindow: 128_000,
      },
      {
        provider: "google-gemini-cli",
        id: "google-gemini-cli/gemini-3.1-pro-preview",
        contextWindow: 1_048_576,
      },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel returns configured override via direct config scan (beats discovery)", async () => {
    // Config has an explicit contextWindow; resolveContextTokensForModel should
    // return it via direct config scan, preventing collisions with raw discovery
    // entries. Real callers (status.summary.ts etc.) always pass cfg.
    mockDiscoveryDeps([
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const cfg = createContextOverrideConfig("google-gemini-cli", "gemini-3.1-pro-preview", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(200_000);
  });

  it("bounds a per-model cap by the Anthropic fixed contract", async () => {
    mockDiscoveryDeps([]);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    expect(
      resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              anthropic: {
                models: [
                  {
                    id: "claude-sonnet-4-6",
                    contextWindow: 2_000_000,
                    contextTokens: 1_200_000,
                  },
                ],
              },
            },
          },
        } as never,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(1_000_000);
  });

  it("bounds an authored effective cap by a smaller authored context window", async () => {
    mockDiscoveryDeps([]);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    expect(
      resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              openai: {
                models: [
                  {
                    id: "gpt-5.6-sol",
                    contextWindow: 128_000,
                    contextTokens: 1_000_000,
                  },
                ],
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.6-sol",
      }),
    ).toBe(128_000);
  });

  it("resolveContextTokensForModel honors configured overrides when provider keys use mixed case", async () => {
    mockDiscoveryDeps([{ id: "openrouter/anthropic/claude-sonnet-4-5", contextWindow: 1_048_576 }]);

    const cfg = createContextOverrideConfig(" OpenRouter ", "anthropic/claude-sonnet-4-5", 200_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel treats explicit config as authoritative for read-only misses", async () => {
    const loadConfig = vi.fn(() => {
      throw new Error("runtime config should not be loaded");
    });
    mockContextModuleDeps(loadConfig);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    const result = resolveContextTokensForModel({
      cfg: { agents: { defaults: {} } } as never,
      provider: "openai",
      model: "unknown-test-model",
      fallbackContextTokens: 123_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(123_000);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("resolveContextTokensForModel: config direct scan prevents OpenRouter qualified key collision for Google provider", async () => {
    // When provider is explicitly "google" and cfg has a Google contextWindow
    // override, the config direct scan returns it before any cache lookup —
    // so the OpenRouter raw "google/gemini-2.5-pro" qualified entry is never hit.
    // Real callers (status.summary.ts) always pass cfg when provider is explicit.
    mockDiscoveryDeps([
      {
        provider: "openrouter",
        id: "google/gemini-2.5-pro",
        contextWindow: 999_000,
      },
    ]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // Google with explicit cfg: config direct scan wins before any cache lookup.
    const googleResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(googleResult).toBe(2_000_000);

    // OpenRouter provider with slash model id: bare lookup finds the raw entry.
    const openrouterResult = resolveContextTokensForModel({
      provider: "openrouter",
      model: "google/gemini-2.5-pro",
    });
    expect(openrouterResult).toBe(999_000);

    // The same raw key must not be treated as provider-owned Google metadata.
    const googleUnconfiguredResult = resolveContextTokensForModel({
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(googleUnconfiguredResult).toBeUndefined();
  });

  it("resolveContextTokensForModel follows modelProvider aliases to per-model config", async () => {
    mockDiscoveryDeps([]);
    const cfg = createContextOverrideConfig("anthropic", "claude-custom", 180_000);
    const resolveContextTokensForModel = await importResolveContextTokensForModel();

    expect(
      resolveContextTokensForModel({
        cfg: cfg as never,
        provider: "fixture-cli",
        modelProvider: "anthropic",
        model: "anthropic/claude-custom",
      }),
    ).toBe(180_000);
  });

  it("resolveContextTokensForModel prefers exact provider key over alias-normalized match", async () => {
    // When both "bedrock" and "amazon-bedrock" exist as config keys (alias pattern),
    // resolveConfiguredProviderContextWindow must return the exact-key match first,
    // not the first normalized hit — mirroring embedded-agent-runner/model.ts behaviour.
    mockDiscoveryDeps([]);

    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": { models: [{ id: "claude-alias-test", contextWindow: 32_000 }] },
          bedrock: { models: [{ id: "claude-alias-test", contextWindow: 128_000 }] },
        },
      },
    };

    const { resolveContextTokensForModel } = await importContextModule();

    // Exact key "bedrock" wins over the alias-normalized match "amazon-bedrock".
    const bedrockResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "bedrock",
      model: "claude-alias-test",
    });
    expect(bedrockResult).toBe(128_000);

    // Exact key "amazon-bedrock" wins (no alias lookup needed).
    const canonicalResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "amazon-bedrock",
      model: "claude-alias-test",
    });
    expect(canonicalResult).toBe(32_000);
  });

  it("resolveContextTokensForModel(model-only) does not apply config scan for inferred provider", async () => {
    // Model-only calls can infer the wrong provider from slash-containing model
    // IDs. Config scans are reserved for explicit providers to avoid that.
    mockDiscoveryDeps([{ id: "google/gemini-2.5-pro", contextWindow: 999_000 }]);

    const cfg = createContextOverrideConfig("google", "gemini-2.5-pro", 2_000_000);
    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google/gemini-2.5-pro");
    await flushAsyncWarmup();

    // model-only call (no explicit provider) must NOT apply config direct scan.
    // Falls through to bare cache lookup: "google/gemini-2.5-pro" → 999k ✓.
    const modelOnlyResult = resolveContextTokensForModel({
      cfg: cfg as never,
      model: "google/gemini-2.5-pro",
      // no provider
    });
    expect(modelOnlyResult).toBe(999_000);

    // Explicit provider still uses config scan ✓.
    const explicitResult = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(explicitResult).toBe(2_000_000);
  });

  it("resolveContextTokensForModel(model-only) does not force 1M for inferred anthropic opus 4.7 ids", async () => {
    mockDiscoveryDeps([{ id: "anthropic/claude-opus-4.7-20260219", contextWindow: 200_000 }]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("anthropic/claude-opus-4.7-20260219");
    await flushAsyncWarmup();

    const result = resolveContextTokensForModel({
      model: "anthropic/claude-opus-4.7-20260219",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(200_000);
  });

  it("resolveContextTokensForModel: qualified key beats bare min when provider is explicit (original #35976 fix)", async () => {
    // Regression: when both "gemini-3.1-pro-preview" (bare, min=128k) AND
    // "google-gemini-cli/gemini-3.1-pro-preview" (qualified, 1M) are in cache,
    // an explicit-provider call must return the provider-specific qualified value,
    // not the collided bare minimum.
    mockDiscoveryDeps([
      {
        provider: "github-copilot",
        id: "gemini-3.1-pro-preview",
        contextWindow: 128_000,
      },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
      {
        provider: "google-gemini-cli",
        id: "gemini-3.1-pro-preview",
        contextWindow: 1_048_576,
      },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // Provider-owned 1M metadata wins over the bare 128k cross-provider minimum.
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel does not match explicit provider id variants before config lookup", async () => {
    mockDiscoveryDeps([]);

    const cfg = createContextOverrideConfig("z.ai", "glm-5", 256_000);
    const { resolveContextTokensForModel } = await importContextModule();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "z-ai",
      model: "glm-5",
    });
    expect(result).toBeUndefined();
  });
});
