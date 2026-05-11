import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    ensureOpenClawModelsJson: vi.fn(async () => {}),
    discoverAuthStorage: vi.fn(() => ({})),
    discoverModels: vi.fn(() => ({
      getAll: () => state.discoveredModels,
    })),
  };
  return state;
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => contextTestState.loadConfigImpl(),
}));

vi.mock("./models-config.runtime.js", () => ({
  ensureOpenClawModelsJson: contextTestState.ensureOpenClawModelsJson,
}));

vi.mock("./pi-model-discovery-runtime.js", () => ({
  discoverAuthStorage: contextTestState.discoverAuthStorage,
  discoverModels: contextTestState.discoverModels,
}));

function mockContextDeps(params: {
  getRuntimeConfig: () => unknown;
  discoveredModels?: DiscoveredModel[];
}) {
  contextTestState.loadConfigImpl = params.getRuntimeConfig;
  contextTestState.discoveredModels = params.discoveredModels ?? [];
  contextTestState.ensureOpenClawModelsJson.mockClear();
  return { ensureOpenClawModelsJson: contextTestState.ensureOpenClawModelsJson };
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

function createContextOverrideConfig(provider: string, model: string, contextWindow: number) {
  return {
    models: {
      providers: {
        [provider]: {
          models: [{ id: model, contextWindow }],
        },
      },
    },
  };
}

async function flushAsyncWarmup() {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
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
    contextModule = await import("./context.js");
  });

  beforeEach(() => {
    contextTestState.loadConfigImpl = () => ({});
    contextTestState.discoveredModels = [];
    contextTestState.ensureOpenClawModelsJson.mockClear();
    contextTestState.discoverAuthStorage.mockClear();
    contextTestState.discoverModels.mockClear();
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
          "openai-codex": {
            models: [{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }],
          },
        },
      },
    }));

    const { lookupContextTokens } = await importContextModule();
    expect(lookupContextTokens("gpt-5.4", { allowAsyncLoad: false })).toBe(272_000);
  });

  it("rehydrates config-backed cache entries after module reload when runtime config survives", async () => {
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

  it("only warms eagerly for real openclaw startup commands that need model metadata", async () => {
    const { shouldEagerWarmContextWindowCache } = await importContextModule();

    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "chat"])).toBe(true);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "chat", "--help"])).toBe(false);
    expect(
      shouldEagerWarmContextWindowCache(["node", "openclaw", "matrix", "encryption", "help"]),
    ).toBe(false);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "help", "matrix"])).toBe(false);
    expect(
      shouldEagerWarmContextWindowCache(["node", "openclaw", "browser", "status", "--help"]),
    ).toBe(false);
    expect(
      shouldEagerWarmContextWindowCache([
        "node",
        "openclaw",
        "--profile",
        "--",
        "config",
        "validate",
      ]),
    ).toBe(false);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "logs", "--limit", "5"])).toBe(
      false,
    );
    expect(
      shouldEagerWarmContextWindowCache(["node", "openclaw", "memory", "search", "--json"]),
    ).toBe(false);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "message", "read"])).toBe(false);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "status", "--json"])).toBe(false);
    expect(shouldEagerWarmContextWindowCache(["node", "openclaw", "sessions", "--json"])).toBe(
      false,
    );
    expect(
      shouldEagerWarmContextWindowCache(["node", "scripts/test-built-plugin-singleton.mjs"]),
    ).toBe(false);
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

  it("returns the smaller window when the same bare model id is discovered under multiple providers", async () => {
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

  it("skips model normalization during warmup but preserves provider-owned context metadata", async () => {
    mockDiscoveryDeps([
      {
        id: "anthropic/claude-opus-4.7-20260219",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ]);

    const { lookupContextTokens } = await importContextModule();
    lookupContextTokens("anthropic/claude-opus-4.7-20260219");
    await flushAsyncWarmup();

    expect(contextTestState.discoverModels).toHaveBeenCalledWith(
      {},
      expect.stringMatching(/\/\.openclaw\/agents\/main\/agent$/),
      { normalizeModels: false },
    );
    expect(lookupContextTokens("anthropic/claude-opus-4.7-20260219")).toBe(1_048_576);
  });

  it("resolveContextTokensForModel returns discovery value when provider-qualified entry exists in cache", async () => {
    // Registry returns provider-qualified entries (real-world scenario from #35976).
    // When no explicit config override exists, the bare cache lookup hits the
    // provider-qualified raw discovery entry.
    mockDiscoveryDeps([
      { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // With provider specified and no config override, bare lookup finds the
    // provider-qualified discovery entry.
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
    mockDiscoveryDeps([{ id: "google/gemini-2.5-pro", contextWindow: 999_000 }]);

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
  });

  it("resolveContextTokensForModel prefers exact provider key over alias-normalized match", async () => {
    // When both "bedrock" and "amazon-bedrock" exist as config keys (alias pattern),
    // resolveConfiguredProviderContextWindow must return the exact-key match first,
    // not the first normalized hit — mirroring pi-embedded-runner/model.ts behaviour.
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
    // status.ts log-usage fallback calls resolveContextTokensForModel({ model })
    // with no provider. When model = "google/gemini-2.5-pro" (OpenRouter ID),
    // resolveProviderModelRef infers provider="google". Without the guard,
    // resolveConfiguredProviderContextWindow would return Google's configured
    // window and misreport context limits for the OpenRouter session.
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
      { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
    ]);

    const { lookupContextTokens, resolveContextTokensForModel } = await importContextModule();
    lookupContextTokens("google-gemini-cli/gemini-3.1-pro-preview");
    await flushAsyncWarmup();

    // Qualified "google-gemini-cli/gemini-3.1-pro-preview" → 1M wins over
    // bare "gemini-3.1-pro-preview" → 128k (cross-provider minimum).
    const result = resolveContextTokensForModel({
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(1_048_576);
  });

  it("resolveContextTokensForModel normalizes explicit provider aliases before config lookup", async () => {
    mockDiscoveryDeps([]);

    const cfg = createContextOverrideConfig("z.ai", "glm-5", 256_000);
    const { resolveContextTokensForModel } = await importContextModule();

    const result = resolveContextTokensForModel({
      cfg: cfg as never,
      provider: "z-ai",
      model: "glm-5",
    });
    expect(result).toBe(256_000);
  });
});
