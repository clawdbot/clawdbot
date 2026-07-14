// Covers context-window cache application and session-manager runtime registry.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionManagerRuntimeRegistry } from "./agent-hooks/session-manager-runtime-registry.js";
import {
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_WINDOW_CACHE,
  providerContextTokenCacheKey,
} from "./context-cache.js";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  ANTHROPIC_FABLE_CONTEXT_TOKENS,
  ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS,
  ANTHROPIC_SONNET_5_CONTEXT_TOKENS,
  ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resetContextWindowCacheForTest,
  resolveContextTokensForModel,
} from "./context.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  projectConfigOntoRuntimeSourceSnapshot: (config: unknown) => config,
}));

function testModelContextWindow(id: string, contextWindow: number) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
  };
}

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when the same bare model id appears under multiple providers", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
        { id: "gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      ],
    });

    // Keep the conservative (minimum) value: this cache feeds runtime paths such
    // as flush thresholds and session persistence, not just /status display.
    // Callers with a known provider should use resolveContextTokensForModel which
    // tries the provider-qualified key first.
    expect(cache.get("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("stores provider-qualified entries independently", () => {
    // Provider-qualified keys retain their exact discovered value; only bare
    // keys collapse to the conservative cross-provider minimum.
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "github-copilot/gemini-3.1-pro-preview", contextWindow: 128_000 },
        { id: "google-gemini-cli/gemini-3.1-pro-preview", contextWindow: 1_048_576 },
      ],
    });

    expect(cache.get("github-copilot/gemini-3.1-pro-preview")).toBe(128_000);
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("prefers discovered contextTokens over contextWindow", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }],
    });

    expect(cache.get("gpt-5.4")).toBe(272_000);
  });

  it("upgrades claude-cli GA 1M variants when discovery still reports 200k", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { id: "claude-cli/claude-opus-4.8-20260514", contextWindow: 200_000 },
        { id: "claude-cli/claude-opus-4.7-20260219", contextWindow: 200_000 },
        { id: "claude-cli/claude-sonnet-4-6", contextWindow: 200_000 },
      ],
    });

    expect(cache.get("claude-cli/claude-opus-4.8-20260514")).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
    expect(cache.get("claude-cli/claude-opus-4.7-20260219")).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
    expect(cache.get("claude-cli/claude-sonnet-4-6")).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not upgrade non-Anthropic GA 1M model ids from discovery", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "github-copilot/claude-opus-4.7", contextWindow: 128_000 }],
    });

    expect(cache.get("github-copilot/claude-opus-4.7")).toBe(128_000);
  });

  it("does not upgrade provider-qualified anthropic GA 1M discovery ids without verified ownership", () => {
    // A slash-prefixed id alone is not proof that Anthropic owns the metadata;
    // discovery must report provider ownership before applying the 1M override.
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "anthropic/claude-opus-4.7-20260219", contextWindow: 200_000 }],
    });

    expect(cache.get("anthropic/claude-opus-4.7-20260219")).toBe(200_000);
  });

  it("upgrades provider-owned anthropic GA 1M discovery ids", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        {
          id: "anthropic/claude-opus-4.7-20260219",
          provider: "anthropic",
          contextWindow: 200_000,
        },
      ],
    });

    expect(cache.get("anthropic/claude-opus-4.7-20260219")).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not upgrade bare GA 1M discovery ids without verified ownership", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "claude-opus-4.7", contextWindow: 128_000 }],
    });

    expect(cache.get("claude-opus-4.7")).toBe(128_000);
  });
});

describe("applyConfiguredContextWindows", () => {
  it("writes bare model id to cache; does not touch raw provider-qualified discovery entries", () => {
    // Discovery stored a raw provider-qualified entry. Config writes the bare
    // key and the collision-free provider-owned key without touching raw keys.
    const cache = new Map<string, number>([["openrouter/anthropic/claude-opus-4-6", 1_000_000]]);
    const windowCache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(windowCache.get("anthropic/claude-opus-4-6")).toBe(200_000);
    expect(
      windowCache.get(providerContextTokenCacheKey("openrouter", "anthropic/claude-opus-4-6")),
    ).toBe(200_000);
    // Discovery entry is untouched — no synthetic write that could corrupt
    // an unrelated provider's raw slash-containing model ID.
    expect(cache.get("openrouter/anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("does not overwrite raw provider-qualified discovery keys", () => {
    // applyConfiguredContextWindows must NOT write "google-gemini-cli/gemini-3.1-pro-preview"
    // into the cache — that keyspace is reserved for raw discovery model IDs and
    // a synthetic write would overwrite unrelated entries (e.g. OpenRouter's
    // "google/gemini-2.5-pro" being clobbered by a Google provider config).
    const cache = new Map<string, number>();
    const windowCache = new Map<string, number>();
    cache.set("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576); // discovery entry
    applyConfiguredContextWindows({
      cache,
      windowCache,
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [{ id: "gemini-3.1-pro-preview", contextWindow: 200_000 }],
          },
        },
      },
    });

    // Bare key is written.
    expect(windowCache.get("gemini-3.1-pro-preview")).toBe(200_000);
    expect(
      windowCache.get(providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview")),
    ).toBe(200_000);
    // Discovery entry is NOT overwritten.
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("writes provider-owned bare keys for self-prefixed configured ids", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache: new Map(),
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [
              {
                id: "google-gemini-cli/gemini-3.1-pro-preview",
                contextTokens: 1_000_000,
              },
            ],
          },
        },
      },
    });

    expect(
      cache.get(providerContextTokenCacheKey("google-gemini-cli", "gemini-3.1-pro-preview")),
    ).toBe(1_000_000);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    const windowCache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", contextWindow: 150_000 },
              { id: "bad/model", contextWindow: 0 },
              { id: "", contextWindow: 300_000 },
            ],
          },
        },
      },
    });

    expect(windowCache.get("custom/model")).toBe(150_000);
    expect(windowCache.has("bad/model")).toBe(false);
  });

  it("prefers configured contextTokens over contextWindow", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache: new Map(),
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "custom/model", contextWindow: 1_050_000, contextTokens: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(200_000);
  });

  it("uses provider-level context defaults for configured model entries", () => {
    const cache = new Map<string, number>();
    const windowCache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      windowCache,
      modelsConfig: {
        providers: {
          ollama: {
            contextWindow: 8_192,
            models: [{ id: "qwen3.5:9b" }],
          },
        },
      },
    });

    expect(windowCache.get("qwen3.5:9b")).toBe(8_192);
  });
});

describe("createSessionManagerRuntimeRegistry", () => {
  it("stores, reads, and clears values by object identity", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    const key = {};
    expect(registry.get(key)).toBeNull();
    registry.set(key, { value: 1 });
    expect(registry.get(key)).toEqual({ value: 1 });
    registry.set(key, null);
    expect(registry.get(key)).toBeNull();
  });

  it("ignores non-object keys", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    registry.set(null, { value: 1 });
    registry.set(123, { value: 1 });
    expect(registry.get(null)).toBeNull();
    expect(registry.get(123)).toBeNull();
  });
});

describe("resolveContextTokensForModel", () => {
  it("can exclude unscoped cache entries from provider-owned lookup", () => {
    resetContextWindowCacheForTest();
    try {
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [{ id: "large", contextTokens: 32_000 }],
      });

      expect(
        resolveContextTokensForModel({
          provider: "claude-cli",
          model: "large",
          allowAsyncLoad: false,
          allowUnscopedModelLookup: false,
        }),
      ).toBeUndefined();
      expect(
        resolveContextTokensForModel({
          provider: "claude-cli",
          model: "large",
          allowAsyncLoad: false,
        }),
      ).toBe(32_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("uses provider-level context defaults when no model-level cap is set", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              contextWindow: 8_192,
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3.5:9b",
      fallbackContextTokens: 216_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(8_192);
  });

  it("prefers model-level context caps over provider-level defaults", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434",
              contextWindow: 8_192,
              models: [{ ...testModelContextWindow("qwen3.5:9b", 216_000), contextTokens: 16_000 }],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3.5:9b",
      fallbackContextTokens: 216_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(16_000);
  });

  it("returns 1M context when anthropic context1m is enabled for a GA 1M model", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("returns 1M context when claude-cli context1m is enabled for a GA 1M model", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "claude-cli/claude-opus-4-7": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "claude-cli",
      model: "claude-opus-4-7",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it.each(["claude-cli", "fixture-cli"])(
    "uses the caller-supplied model provider for the %s runtime",
    (provider) => {
      const result = resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com",
                models: [
                  {
                    ...testModelContextWindow("claude-opus-4-7", 200_000),
                    contextTokens: 100_000,
                  },
                ],
              },
            },
          },
        },
        provider,
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      });

      expect(result).toBe(100_000);
    },
  );

  it("returns 1M context for GA-capable Anthropic 4.x models even without context1m", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {},
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it.each([
    ["anthropic", "claude-fable-5", ANTHROPIC_FABLE_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-fable-5", ANTHROPIC_FABLE_CONTEXT_TOKENS],
    ["anthropic", "claude-mythos-5", ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-mythos-5", ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS],
    ["anthropic", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["claude-cli", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["anthropic", "claude-sonnet-4-6", ANTHROPIC_CONTEXT_1M_TOKENS],
    ["anthropic-vertex", "claude-sonnet-4-6", ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS],
  ])(
    "returns the fixed context for unconfigured %s model %s",
    (provider, modelId, expectedContextTokens) => {
      const result = resolveContextTokensForModel({
        provider,
        model: modelId,
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      });

      expect(result).toBe(expectedContextTokens);
    },
  );

  it("does not give fable-5 context window to claude-fable-50 (prefix boundary check)", () => {
    const result = resolveContextTokensForModel({
      provider: "anthropic",
      model: "claude-fable-50",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it("does not give mythos-5 context window to claude-mythos-50", () => {
    const result = resolveContextTokensForModel({
      provider: "anthropic",
      model: "claude-mythos-50",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it.each([
    ["anthropic", "claude-fable-5"],
    ["anthropic-vertex", "claude-fable-5"],
    ["anthropic", "claude-sonnet-4-6"],
    ["anthropic-vertex", "claude-sonnet-4-6"],
  ])("honors an authored %s window for fixed model %s", (provider, modelId) => {
    expect(
      resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://aiplatform.googleapis.com",
                models: [testModelContextWindow(modelId, 200_000)],
              },
            },
          },
        },
        provider,
        model: modelId,
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(200_000);
  });

  it("clamps an authored Anthropic window to the fixed provider limit", () => {
    expect(
      resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com",
                models: [testModelContextWindow("claude-sonnet-4-6", 2_000_000)],
              },
            },
          },
        },
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        allowAsyncLoad: false,
      }),
    ).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("uses an authored provider window instead of the model's materialized default", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            contextWindow: 500_000,
            models: [testModelContextWindow("claude-sonnet-4-6", 200_000)],
          },
        },
      },
    } satisfies OpenClawConfig;
    const sourceCfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            contextWindow: 500_000,
            models: [{ id: "claude-sonnet-4-6" } as never],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveContextTokensForModel({
        cfg,
        sourceCfg,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        allowAsyncLoad: false,
      }),
    ).toBe(500_000);
  });

  it("keeps fixed Anthropic context above stale static native-window metadata", () => {
    expect(
      resolveContextTokensForModel({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        modelContextWindow: 200_000,
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it.each([
    ["anthropic", "claude-fable-5", ANTHROPIC_FABLE_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-fable-5", ANTHROPIC_FABLE_CONTEXT_TOKENS],
    ["anthropic", "claude-mythos-5", ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-mythos-5", ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS],
    ["anthropic", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["anthropic-vertex", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["claude-cli", "claude-sonnet-5", ANTHROPIC_SONNET_5_CONTEXT_TOKENS],
    ["anthropic", "claude-sonnet-4-6", ANTHROPIC_CONTEXT_1M_TOKENS],
    ["anthropic-vertex", "claude-sonnet-4-6", ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS],
  ])(
    "ignores a materialized lower context window for fixed %s model %s",
    (provider, modelId, expectedContextTokens) => {
      const result = resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://api.anthropic.com",
                models: [testModelContextWindow(modelId, 200_000)],
              },
            },
          },
        },
        sourceCfg: {},
        provider,
        model: modelId,
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      });

      expect(result).toBe(expectedContextTokens);
    },
  );

  it("honors an explicit lower contextTokens cap for a fixed Anthropic model", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  ...testModelContextWindow("claude-sonnet-4-6", 200_000),
                  contextTokens: 200_000,
                },
              ],
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it("keeps older Anthropic Sonnet 4.x models at the configured window when context1m is set", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [testModelContextWindow("claude-sonnet-4-5", 200_000)],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it("does not force 1M context for non-opus/sonnet Anthropic models", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [testModelContextWindow("claude-haiku-3-5", 200_000)],
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-haiku-3-5": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      provider: "anthropic",
      model: "claude-haiku-3-5",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it("returns 1M context for claude opus 4.7 variants without context1m", () => {
    const result = resolveContextTokensForModel({
      provider: "claude-cli",
      model: "claude-opus-4.7-20260219",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not force 1M context for non-Anthropic providers with opus 4.7 ids", () => {
    const result = resolveContextTokensForModel({
      provider: "github-copilot",
      model: "claude-opus-4.7",
      fallbackContextTokens: 128_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(128_000);
  });

  it("does not force 1M context for model-only anthropic opus 4.7 ids", () => {
    const result = resolveContextTokensForModel({
      model: "anthropic/claude-opus-4.7-20260219",
      fallbackContextTokens: 200_000,
      allowAsyncLoad: false,
    });

    expect(result).toBe(200_000);
  });

  it("prefers per-model contextTokens config over contextWindow", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api",
              models: [
                {
                  id: "gpt-5.4",
                  name: "gpt-5.4",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_050_000,
                  contextTokens: 160_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      fallbackContextTokens: 272_000,
    });

    expect(result).toBe(160_000);
  });

  it("caps override by known model context window", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api",
              models: [testModelContextWindow("gpt-5.4", 900_000)],
            },
          },
        },
      },
      contextTokensOverride: 1_048_000,
      provider: "openai",
      model: "gpt-5.4",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(900_000);
  });

  it("prefers lower override when it is already below the model context window", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api",
              models: [testModelContextWindow("gpt-5.4", 900_000)],
            },
          },
        },
      },
      contextTokensOverride: 128_000,
      provider: "openai",
      model: "gpt-5.4",
      fallbackContextTokens: 200_000,
    });

    expect(result).toBe(128_000);
  });

  it("caps provider-owned entries without trusting ambiguous slash-containing ids", () => {
    resetContextWindowCacheForTest();
    try {
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [
          { id: "gpt-5.5", contextWindow: 272_000 },
          {
            provider: "openrouter",
            id: "google/gemini-2.5-pro",
            contextWindow: 128_000,
          },
        ],
      });

      const resolveCached = (provider: string, model: string) =>
        resolveContextTokensForModel({
          provider,
          model,
          contextTokensOverride: 1_000_000,
          fallbackContextTokens: 200_000,
          allowAsyncLoad: false,
        });

      expect(resolveCached("openai", "gpt-5.5")).toBe(272_000);
      expect(resolveCached("openrouter", "google/gemini-2.5-pro")).toBe(128_000);

      resetContextWindowCacheForTest();
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [{ id: "google/gemini-2.5-pro", contextWindow: 128_000 }],
      });
      expect(resolveCached("openrouter", "google/gemini-2.5-pro")).toBe(1_000_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("keeps configured contextTokens authoritative over lower discovery", () => {
    resetContextWindowCacheForTest();
    try {
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [{ provider: "openai", id: "gpt-5.5", contextWindow: 272_000 }],
      });
      applyConfiguredContextWindows({
        cache: MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
        windowCache: MODEL_CONTEXT_WINDOW_CACHE,
        modelsConfig: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.5", contextTokens: 350_000 }],
            },
          },
        },
      });

      expect(
        resolveContextTokensForModel({
          provider: "openai",
          model: "gpt-5.5",
          contextTokensOverride: 1_000_000,
          allowAsyncLoad: false,
        }),
      ).toBe(350_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("prefers verified provider discovery over static catalog fallbacks", () => {
    resetContextWindowCacheForTest();
    try {
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [{ provider: "openai", id: "gpt-5.5", contextTokens: 200_000 }],
      });

      expect(
        resolveContextTokensForModel({
          provider: "openai",
          model: "gpt-5.5",
          modelContextWindow: 1_000_000,
          modelContextTokens: 272_000,
          contextTokensOverride: 1_000_000,
          allowAsyncLoad: false,
        }),
      ).toBe(200_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("keeps verified provider discovery ahead of static caps under configured windows", () => {
    resetContextWindowCacheForTest();
    try {
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models: [{ provider: "openai", id: "gpt-5.5", contextTokens: 200_000 }],
      });

      expect(
        resolveContextTokensForModel({
          cfg: {
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  models: [testModelContextWindow("gpt-5.5", 1_000_000)],
                },
              },
            },
          },
          provider: "openai",
          model: "gpt-5.5",
          modelContextTokens: 272_000,
          contextTokensOverride: 1_000_000,
          allowAsyncLoad: false,
        }),
      ).toBe(200_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("keeps configured native windows separate from prepared runtime caps", () => {
    resetContextWindowCacheForTest();
    try {
      applyConfiguredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        windowCache: MODEL_CONTEXT_WINDOW_CACHE,
        modelsConfig: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }],
            },
          },
        },
      });

      expect(
        resolveContextTokensForModel({
          provider: "openai",
          model: "gpt-5.5",
          modelContextTokens: 272_000,
          contextTokensOverride: 1_000_000,
          allowAsyncLoad: false,
        }),
      ).toBe(272_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });

  it("caps prepared runtime tokens by a lower configured native window", () => {
    resetContextWindowCacheForTest();
    try {
      applyConfiguredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        windowCache: MODEL_CONTEXT_WINDOW_CACHE,
        modelsConfig: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.5", contextWindow: 128_000 }],
            },
          },
        },
      });

      expect(
        resolveContextTokensForModel({
          provider: "openai",
          model: "gpt-5.5",
          modelContextTokens: 272_000,
          contextTokensOverride: 1_000_000,
          allowAsyncLoad: false,
        }),
      ).toBe(128_000);
    } finally {
      resetContextWindowCacheForTest();
    }
  });
});
