// Verifies default model alias config values and overrides.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { applyModelDefaults as applyModelDefaultsWithPolicy } from "./defaults.js";
import type { ModelProviderConfig, OpenClawConfig } from "./types.js";

const providerPolicyMocks = vi.hoisted(() => ({
  normalizeProviderConfigForConfigDefaults: vi.fn(
    (params: { providerConfig: ModelProviderConfig }) => params.providerConfig,
  ),
}));

vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (params: { config: OpenClawConfig }) => params.config,
  normalizeProviderConfigForConfigDefaults: (
    ...args: Parameters<typeof providerPolicyMocks.normalizeProviderConfigForConfigDefaults>
  ) => providerPolicyMocks.normalizeProviderConfigForConfigDefaults(...args),
}));

const emptyManifestRegistry = { plugins: [] } satisfies Pick<PluginManifestRegistry, "plugins">;

function applyModelDefaults(
  cfg: OpenClawConfig,
  options?: Parameters<typeof applyModelDefaultsWithPolicy>[1],
) {
  return applyModelDefaultsWithPolicy(cfg, options ?? { manifestRegistry: emptyManifestRegistry });
}

describe("applyModelDefaults", () => {
  beforeEach(() => {
    providerPolicyMocks.normalizeProviderConfigForConfigDefaults.mockReset();
    providerPolicyMocks.normalizeProviderConfigForConfigDefaults.mockImplementation(
      (params) => params.providerConfig,
    );
  });

  function mockNormalizedProvider(provider: ModelProviderConfig) {
    providerPolicyMocks.normalizeProviderConfigForConfigDefaults.mockReturnValueOnce(provider);
  }

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

  function buildProviderTokenDefaultsConfig(params: {
    provider: { contextWindow?: number; contextTokens?: number; maxTokens?: number };
    model?: { contextWindow?: number; contextTokens?: number; maxTokens?: number };
  }) {
    return {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            ...params.provider,
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...params.model,
              },
            ],
          },
        },
      },
    } as never;
  }

  function buildCustomProviderManifestRegistry() {
    return {
      plugins: [
        {
          id: "custom-provider-plugin",
          channels: [],
          providers: ["myproxy"],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "config",
          rootDir: "/tmp/custom-provider-plugin",
          source: "test",
          manifestPath: "/tmp/custom-provider-plugin/openclaw.plugin.json",
          modelIdNormalization: {
            providers: {
              myproxy: {
                aliases: {
                  latest: "modern-model",
                },
                prefixWhenBare: "vendor",
              },
            },
          },
        },
      ],
      diagnostics: [],
    } satisfies PluginManifestRegistry;
  }

  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": {},
            "anthropic/claude-sonnet-5": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-8"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-5"]?.alias).toBe("sonnet");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.4"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": { alias: "Opus" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-8"]?.alias).toBe("Opus");
  });

  it("preserves an authored Sonnet alias when the new default target is also present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "anthropic/claude-sonnet-5": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.alias).toBe("Sonnet");
    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-5"]?.alias).toBeUndefined();
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
    expect(next.agents?.defaults?.models?.["google/gemini-3.1-flash-lite"]?.alias).toBe(
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

  it("normalizes the retired Together default primary and fallback refs", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "together/moonshotai/Kimi-K2.5",
            fallbacks: ["together/moonshotai/Kimi-K2.5", "openai/gpt-5.5"],
          },
          models: {
            "together/moonshotai/Kimi-K2.5": {},
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.model).toEqual({
      primary: "together/moonshotai/Kimi-K2.6",
      fallbacks: ["together/moonshotai/Kimi-K2.6", "openai/gpt-5.5"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "together/moonshotai/Kimi-K2.6": {},
    });
  });

  it("normalizes retired Gemini per-agent model refs", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview"],
            },
            models: {
              "google/gemini-3-pro-preview": {},
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.list?.[0]?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(next.agents?.list?.[0]?.models).toEqual({
      "google/gemini-3.1-pro-preview": {},
    });
  });

  it("applies provider policy normalization to configured provider rows", () => {
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

    const provider = cfg.models.providers.google;
    mockNormalizedProvider({
      ...provider,
      models: provider.models.map((model) =>
        Object.assign({}, model, { id: "google/gemini-3.1-pro-preview" }),
      ),
    });

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("preserves an explicit provider api after provider policy normalization", () => {
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

    const provider = cfg.models.providers.google;
    mockNormalizedProvider({
      ...provider,
      models: provider.models.map((model) =>
        Object.assign({}, model, { id: "google/gemini-3.1-pro-preview" }),
      ),
    });

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.google?.api).toBe("openai-completions");
    expect(next.models?.providers?.google?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("normalizes nested retired Gemini ids in proxy provider rows", () => {
    const cfg = buildProxyProviderConfig();
    const model = expectDefined(
      cfg.models.providers.myproxy.models[0],
      "cfg.models.providers.myproxy.models[0] test invariant",
    );
    model.id = "google/gemini-3-pro-preview";
    model.name = "Gemini via proxy";

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe("google/gemini-3.1-pro-preview");
  });

  it("normalizes provider-prefixed nested retired Gemini ids in proxy provider rows", () => {
    const cfg = buildProxyProviderConfig();
    const model = expectDefined(
      cfg.models.providers.myproxy.models[0],
      "cfg.models.providers.myproxy.models[0] test invariant",
    );
    model.id = "myproxy/google/gemini-3-pro-preview";
    model.name = "Gemini via proxy";

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe(
      "myproxy/google/gemini-3.1-pro-preview",
    );
  });

  it("normalizes configured provider rows with explicit manifest registry policies", () => {
    const cfg = buildProxyProviderConfig();
    const model = expectDefined(
      cfg.models.providers.myproxy.models[0],
      "cfg.models.providers.myproxy.models[0] test invariant",
    );
    model.id = "latest";
    model.name = "Custom latest";

    const next = applyModelDefaults(cfg, {
      manifestRegistry: buildCustomProviderManifestRegistry(),
    });

    expect(next.models?.providers?.myproxy?.models?.[0]?.id).toBe("vendor/modern-model");
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

  it.each([
    {
      name: "inherits provider defaults",
      provider: { contextWindow: 50_000, contextTokens: 32_000, maxTokens: 4_096 },
      model: undefined,
      expected: { contextWindow: 50_000, contextTokens: 32_000, maxTokens: 4_096 },
    },
    {
      name: "keeps model overrides",
      provider: { contextWindow: 50_000, contextTokens: 32_000, maxTokens: 4_096 },
      model: { contextWindow: 10_000, contextTokens: 8_000, maxTokens: 2_048 },
      expected: { contextWindow: 10_000, contextTokens: 8_000, maxTokens: 2_048 },
    },
    {
      name: "clamps inherited maxTokens to the inherited contextWindow",
      provider: { contextWindow: 4_096, maxTokens: 8_192 },
      model: undefined,
      expected: { contextWindow: 4_096, contextTokens: undefined, maxTokens: 4_096 },
    },
  ])("$name", ({ provider, model, expected }) => {
    const cfg = buildProviderTokenDefaultsConfig({ provider, model });

    const next = applyModelDefaults(cfg);
    const resolved = next.models?.providers?.myproxy?.models?.[0];

    expect({
      contextWindow: resolved?.contextWindow,
      contextTokens: resolved?.contextTokens,
      maxTokens: resolved?.maxTokens,
    }).toEqual(expected);
  });

  it("normalizes stale mistral maxTokens that matched the full context window", () => {
    const cfg = buildMistralProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.mistral?.models?.[0];

    expect(model?.contextWindow).toBe(262144);
    expect(model?.maxTokens).toBe(16384);
  });

  it("caps explicit mistral maxTokens above the named model limit", () => {
    const cfg = buildMistralProviderConfig({ maxTokens: 17_000 });

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.mistral?.models?.[0]?.maxTokens).toBe(16_384);
  });

  it.each(["custom-mistral-model", "constructor"])(
    "preserves explicit maxTokens for custom mistral model %s",
    (modelId) => {
      const cfg = buildMistralProviderConfig({
        modelId,
        contextWindow: 128_000,
        maxTokens: 32_000,
      });

      const next = applyModelDefaults(cfg);

      expect(next.models?.providers?.mistral?.models?.[0]?.maxTokens).toBe(32_000);
    },
  );

  it("keeps the safe fallback for context-sized custom mistral maxTokens", () => {
    const cfg = buildMistralProviderConfig({
      modelId: "custom-mistral-model",
      contextWindow: 128_000,
      maxTokens: 128_000,
    });

    const next = applyModelDefaults(cfg);

    expect(next.models?.providers?.mistral?.models?.[0]?.maxTokens).toBe(8192);
  });

  it("propagates a provider policy api default to models", () => {
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

    mockNormalizedProvider({
      ...cfg.models.providers.anthropic,
      api: "anthropic-messages",
    });

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
