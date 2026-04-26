import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resolveContextTokensForModel,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-hooks/session-manager-runtime-registry.js";

vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));

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

  it("upgrades claude opus 4.7 variants to 1M when discovery still reports 200k", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "claude-cli/claude-opus-4.7-20260219", contextWindow: 200_000 }],
    });

    expect(cache.get("claude-cli/claude-opus-4.7-20260219")).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not upgrade non-Anthropic opus 4.7 variants from discovery", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "github-copilot/claude-opus-4.7", contextWindow: 128_000 }],
    });

    expect(cache.get("github-copilot/claude-opus-4.7")).toBe(128_000);
  });

  it("does not upgrade provider-qualified anthropic opus 4.7 discovery ids without verified ownership", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ id: "anthropic/claude-opus-4.7-20260219", contextWindow: 200_000 }],
    });

    expect(cache.get("anthropic/claude-opus-4.7-20260219")).toBe(200_000);
  });

  it("does not upgrade bare opus 4.7 discovery ids without verified ownership", () => {
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
    // Discovery stored a provider-qualified entry; config override goes into the
    // bare key only. resolveContextTokensForModel now scans config directly, so
    // there is no need (and no benefit) to also write a synthetic qualified key.
    const cache = new Map<string, number>([["openrouter/anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
    // Discovery entry is untouched — no synthetic write that could corrupt
    // an unrelated provider's raw slash-containing model ID.
    expect(cache.get("openrouter/anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("does not write synthetic provider-qualified keys; only bare model ids go into cache", () => {
    // applyConfiguredContextWindows must NOT write "google-gemini-cli/gemini-3.1-pro-preview"
    // into the cache — that keyspace is reserved for raw discovery model IDs and
    // a synthetic write would overwrite unrelated entries (e.g. OpenRouter's
    // "google/gemini-2.5-pro" being clobbered by a Google provider config).
    const cache = new Map<string, number>();
    cache.set("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576); // discovery entry
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [{ id: "gemini-3.1-pro-preview", contextWindow: 200_000 }],
          },
        },
      },
    });

    // Bare key is written.
    expect(cache.get("gemini-3.1-pro-preview")).toBe(200_000);
    // Discovery entry is NOT overwritten.
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
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

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });

  it("prefers configured contextTokens over contextWindow", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
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
  it("returns 1M context when anthropic context1m is enabled for opus/sonnet", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [testModelContextWindow("claude-opus-4-6", 200_000)],
            },
          },
        },
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

  it("returns 1M context when claude-cli context1m is enabled for opus/sonnet", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "claude-cli": {
              baseUrl: "https://api.anthropic.com",
              models: [testModelContextWindow("claude-opus-4-7", 200_000)],
            },
          },
        },
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

  it("does not force 1M context when context1m is not enabled", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [testModelContextWindow("claude-opus-4-6", 200_000)],
            },
          },
        },
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
            "openai-codex": {
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
      provider: "openai-codex",
      model: "gpt-5.4",
      fallbackContextTokens: 272_000,
    });

    expect(result).toBe(160_000);
  });
});
