import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { applyModelDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

describe("applyModelDefaults", () => {
  beforeEach(() => {
    vi.stubEnv(
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      path.resolve(import.meta.dirname, "../../extensions"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function buildProxyProviderConfig(overrides?: { contextWindow?: number; maxTokens?: number }) {
    return {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.2",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: overrides?.contextWindow ?? 200_000,
                maxTokens: overrides?.maxTokens ?? 8192,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  function buildMistralProviderConfig(overrides?: {
    modelId?: string;
    contextWindow?: number;
    maxTokens?: number;
  }) {
    return {
      models: {
        providers: {
          mistral: {
            baseUrl: "https://api.mistral.ai/v1",
            apiKey: "sk-mistral", // pragma: allowlist secret
            api: "openai-completions",
            models: [
              {
                id: overrides?.modelId ?? "mistral-large-latest",
                name: "Mistral",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: overrides?.contextWindow ?? 262_144,
                maxTokens: overrides?.maxTokens ?? 262_144,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-7": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-7"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.4"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-7"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "" },
            "google/gemini-3-flash-preview": {},
            "google/gemini-3.1-flash-lite-preview": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3.1-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3-flash-preview"]?.alias).toBe(
      "gemini-flash",
    );
    expect(next.agents?.defaults?.models?.["google/gemini-3.1-flash-lite-preview"]?.alias).toBe(
      "gemini-flash-lite",
    );
  });

  it("normalizes retired Gemini model keys before applying aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
    });
  });

  it("normalizes retired Gemini primary and fallback refs", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["google/gemini-3-pro-preview", "openai/gpt-5.5"],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
    });
  });

  it("normalizes provider-prefixed Gemini ids in configured Google provider rows", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            api: "google-generative-ai",
            apiKey: "GOOGLE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("normalizes provider-prefixed Gemini ids for OpenAI-compatible Google provider rows", () => {
    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions",
            apiKey: "GOOGLE_API_KEY",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro",
                input: ["text", "image"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_048_576,
                maxTokens: 65_536,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.google?.api).toBe("openai-completions");
    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("normalizes nested retired Gemini ids in proxy provider rows", () => {
    const cfg = buildProxyProviderConfig();
    const model = cfg.models.providers.myproxy.models[0];
    model.id = "google/gemini-3-pro-preview";
    model.name = "Gemini via proxy";

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("fills missing model provider defaults", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(model?.maxTokens).toBe(8192);
  });

  it("clamps maxTokens to contextWindow", () => {
    const cfg = buildProxyProviderConfig({ contextWindow: 32768, maxTokens: 40960 });

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.contextWindow).toBe(32768);
    expect(model?.maxTokens).toBe(32768);
  });

  it("normalizes stale mistral maxTokens that matched the full context window", () => {
    const cfg = buildMistralProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.mistral?.models?.[0];

    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxTokens).toBe(16384);
  });

  it("defaults anthropic provider and model api to anthropic-messages", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://relay.example.com/api",
            apiKey: "cr_xxxx", // pragma: allowlist secret
            models: [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const provider = next.models?.providers?.anthropic;
    const model = provider?.models?.[0];

    expect(provider?.api).toBe("anthropic-messages");
    expect(model?.api).toBe("anthropic-messages");
  });

  it("propagates provider api to models when model api is missing", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];
    expect(model?.api).toBe("openai-completions");
  });
});
