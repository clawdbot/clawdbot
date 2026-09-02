// Exercises core model selection, aliases, thinking defaults, and visibility policy.
import { afterEach, describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  getModelRefStatus as getNarrowModelRefStatus,
  resolveAllowedModelRefCore as resolveNarrowAllowedModelRef,
} from "./model-selection-resolve.js";
import { isModelKeyAllowedBySet } from "./model-selection-shared.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  inferUniqueProviderFromConfiguredModels,
  getModelRefStatus,
  parseModelRef,
  buildModelAliasIndex,
  normalizeModelSelection,
  normalizeProviderId,
  normalizeProviderIdForAuth,
  modelKey,
  resolvePersistedOverrideModelRef,
  resolvePersistedModelRef,
  resolvePersistedSelectedModelRef,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
  resolveThinkingDefault,
  resolveModelRefFromString,
} from "./model-selection.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

const manifestNormalizationSnapshot = {
  configFingerprint: "model-selection-test-normalizers",
  ...createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "model-selection-test-normalizers",
        modelIdNormalization: {
          providers: {
            anthropic: {
              aliases: {
                "opus-4.6": "claude-opus-4-6",
                "opus-4.5": "claude-opus-4-5",
                "sonnet-4.6": "claude-sonnet-4-6",
                "sonnet-4.5": "claude-sonnet-4-5",
              },
            },
            google: {
              aliases: {
                "gemini-3-pro": "gemini-3.1-pro-preview",
                "gemini-3-flash": "gemini-3-flash-preview",
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
                "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
                "gemini-3.1-flash": "gemini-3-flash-preview",
                "gemini-3.1-flash-preview": "gemini-3-flash-preview",
              },
            },
            "google-vertex": {
              aliases: {
                "gemini-3-pro": "gemini-3.1-pro-preview",
                "gemini-3-flash": "gemini-3-flash-preview",
                "gemini-3.1-pro": "gemini-3.1-pro-preview",
                "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
                "gemini-3.1-flash": "gemini-3-flash-preview",
                "gemini-3.1-flash-preview": "gemini-3-flash-preview",
              },
            },
            xai: { aliases: {} },
            openrouter: {
              prefixWhenBare: "openrouter",
            },
            huggingface: {
              stripPrefixes: ["huggingface/"],
            },
            "vercel-ai-gateway": {
              aliases: {
                "opus-4.6": "claude-opus-4-6",
                "opus-4.5": "claude-opus-4-5",
                "sonnet-4.6": "claude-sonnet-4-6",
                "sonnet-4.5": "claude-sonnet-4-5",
              },
              prefixWhenBareAfterAliasStartsWith: [
                {
                  modelPrefix: "claude-",
                  prefix: "anthropic",
                },
              ],
            },
            nvidia: {
              prefixWhenBare: "nvidia",
            },
          },
        },
      },
    ],
  }),
};

const providerModelNormalizationMock = vi.hoisted(() => ({
  normalizeProviderModelIdWithRuntime: vi.fn(() => undefined),
}));

const providerPolicySurfaceMock = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn((providerId: string) => {
    if (providerId !== "anthropic" && providerId !== "amazon-bedrock") {
      return null;
    }
    return {
      resolveThinkingProfile: (context: { modelId: string }) =>
        context.modelId.includes("claude-") && context.modelId.includes("4-6")
          ? {
              levels: [
                { id: "off", label: "off", rank: 0 },
                { id: "adaptive", label: "adaptive", rank: 6 },
              ],
              defaultLevel: "adaptive",
            }
          : undefined,
    };
  }),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => manifestNormalizationSnapshot,
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime:
    providerModelNormalizationMock.normalizeProviderModelIdWithRuntime,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface:
    providerPolicySurfaceMock.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerPolicySurfaceMock.resolveBundledProviderPolicySurface,
}));

vi.mock("./model-selection-cli.js", () => ({
  isCliProvider: () => false,
}));

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

const EXPLICIT_ALLOWLIST_CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      },
      modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
    },
  },
} as OpenClawConfig;

const BUNDLED_ALLOWLIST_CATALOG = [
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
  { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
];

const ANTHROPIC_OPUS_CATALOG = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
  },
];

function resolveAnthropicOpusThinking(cfg: OpenClawConfig) {
  // Helper keeps thinking-default assertions focused on config differences
  // while using the same catalog metadata shape as production selection.
  return resolveThinkingDefault({
    cfg,
    provider: "anthropic",
    model: "claude-opus-4-6",
    catalog: ANTHROPIC_OPUS_CATALOG,
  });
}

function createAgentFallbackConfig(params: {
  primary?: string;
  fallbacks?: string[];
  agentFallbacks?: string[];
}) {
  // Compact fixture for primary/fallback allowlist tests.
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-4o": {},
        },
        modelPolicy: { allow: ["openai/gpt-4o"] },
        model: {
          primary: params.primary ?? "openai/gpt-4o",
          fallbacks: params.fallbacks ?? [],
        },
      },
      ...(params.agentFallbacks
        ? {
            list: [
              {
                id: "coder",
                model: {
                  primary: params.primary ?? "openai/gpt-4o",
                  fallbacks: params.agentFallbacks,
                },
              },
            ],
          }
        : {}),
    },
  } as OpenClawConfig;
}

function createProviderWithModelsConfig(provider: string, models: Array<Record<string, unknown>>) {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: `https://${provider}.example.com`,
          models,
        },
      },
    },
  } as Partial<OpenClawConfig>;
}

function createConfiguredModelRefConfig(params: {
  primary?: string;
  modelEntries?: Record<string, unknown>;
  providers?: Record<string, unknown>;
}) {
  return {
    ...(params.primary !== undefined || params.modelEntries
      ? {
          agents: {
            defaults: {
              ...(params.primary !== undefined ? { model: { primary: params.primary } } : {}),
              ...(params.modelEntries ? { models: params.modelEntries } : {}),
            },
          },
        }
      : {}),
    ...(params.providers ? { models: { providers: params.providers } } : {}),
  } as unknown as OpenClawConfig;
}

function createSubagentSelectionConfig(params: {
  defaultPrimary?: string;
  modelEntries?: Record<string, unknown>;
  defaultSubagentModel?: string;
  agents?: Array<Record<string, unknown>>;
}) {
  return {
    agents: {
      defaults: {
        model: { primary: params.defaultPrimary ?? "anthropic/claude-sonnet-4-6" },
        ...(params.modelEntries ? { models: params.modelEntries } : {}),
        ...(params.defaultSubagentModel
          ? { subagents: { model: params.defaultSubagentModel } }
          : {}),
      },
      ...(params.agents ? { list: params.agents } : {}),
    },
  } as unknown as OpenClawConfig;
}

function createProviderInferenceAllowlistConfig(...modelRefs: string[]) {
  return {
    agents: {
      defaults: {
        models: Object.fromEntries(modelRefs.map((modelRef) => [modelRef, {}])),
      },
    },
  } as OpenClawConfig;
}

function createProviderInferenceCatalogConfig(providers: Record<string, string[]>) {
  return {
    models: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([provider, modelIds]) => [
          provider,
          { models: modelIds.map((id) => ({ id })) },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

function resolveConfiguredRefForTest(cfg: Partial<OpenClawConfig>) {
  return resolveConfiguredModelRef({
    cfg: cfg as OpenClawConfig,
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
  });
}

describe("model-selection", () => {
  it("shares the lightweight runtime resolver with the public selection facade", () => {
    expect(getModelRefStatus).toBe(getNarrowModelRefStatus);
    const params = {
      cfg: {} as OpenClawConfig,
      catalog: [],
      raw: "anthropic/claude-sonnet-4-6",
      defaultProvider: "anthropic",
    };
    expect(resolveAllowedModelRef(params)).toEqual(resolveNarrowAllowedModelRef(params));
  });

  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("z.ai");
      expect(normalizeProviderId("z-ai")).toBe("z-ai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode-zen");
      expect(normalizeProviderId("qwen")).toBe("qwen");
      expect(normalizeProviderId("kimi-code")).toBe("kimi-code");
      expect(normalizeProviderId("kimi-coding")).toBe("kimi-coding");
      expect(normalizeProviderId("MoonshotAI")).toBe("moonshotai");
      expect(normalizeProviderId("moonshot-ai")).toBe("moonshot-ai");
      expect(normalizeProviderId("bedrock")).toBe("bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("aws-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("normalizeProviderIdForAuth", () => {
    it("only applies lowercase provider-id normalization before auth alias lookup", () => {
      expect(normalizeProviderIdForAuth("qwencloud")).toBe("qwencloud");
      expect(normalizeProviderIdForAuth("openai")).toBe("openai");
      expect(normalizeProviderIdForAuth("openai")).toBe("openai");
    });
  });

  describe("modelKey", () => {
    it("keeps canonical OpenRouter native ids without duplicating the provider", () => {
      expect(modelKey("openrouter", "openrouter/hunter-alpha")).toBe("openrouter/hunter-alpha");
    });
  });

  describe("parseModelRef", () => {
    const expectParsedModelVariants = (
      variants: string[],
      defaultProvider: string,
      expected: { provider: string; model: string },
    ) => {
      for (const raw of variants) {
        expect(
          parseModelRef(raw, defaultProvider, { allowPluginNormalization: false }),
          raw,
        ).toEqual(expected);
      }
    };

    const parseModelRefCases = [
      {
        name: "parses explicit provider/model refs",
        variants: ["anthropic/claude-3-5-sonnet"],
        defaultProvider: "openai",
        expected: { provider: "anthropic", model: "claude-3-5-sonnet" },
      },
      {
        name: "uses the default provider when omitted",
        variants: ["claude-3-5-sonnet"],
        defaultProvider: "anthropic",
        expected: { provider: "anthropic", model: "claude-3-5-sonnet" },
      },
      {
        name: "preserves nested model ids after the provider prefix",
        variants: ["nvidia/moonshotai/kimi-k2.5"],
        defaultProvider: "anthropic",
        expected: { provider: "nvidia", model: "moonshotai/kimi-k2.5" },
      },
      {
        name: "preserves nested MLX model ids after the provider prefix",
        variants: ["mlx/mlx-community/Qwen3-30B-A3B-6bit"],
        defaultProvider: "anthropic",
        expected: { provider: "mlx", model: "mlx-community/Qwen3-30B-A3B-6bit" },
      },
      {
        name: "preserves three-segment refs where the maker equals the provider",
        variants: ["nvidia/nvidia/nemotron-3-super-120b-a12b"],
        defaultProvider: "anthropic",
        expected: { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b" },
      },
      {
        name: "normalizes anthropic shorthand aliases",
        variants: ["anthropic/opus-4.6", "opus-4.6", " anthropic / opus-4.6 "],
        defaultProvider: "anthropic",
        expected: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      {
        name: "normalizes anthropic sonnet aliases",
        variants: ["anthropic/sonnet-4.6", "sonnet-4.6"],
        defaultProvider: "anthropic",
        expected: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      {
        name: "keeps dated anthropic model ids unchanged",
        variants: ["anthropic/claude-sonnet-4-20250514", "claude-sonnet-4-20250514"],
        defaultProvider: "anthropic",
        expected: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      },
      {
        name: "normalizes deprecated google flash preview ids",
        variants: ["google/gemini-3.1-flash-preview", "gemini-3.1-flash-preview"],
        defaultProvider: "google",
        expected: { provider: "google", model: "gemini-3-flash-preview" },
      },
      {
        name: "normalizes retired google gemini 3 pro preview ids",
        variants: ["google/gemini-3-pro-preview", "gemini-3-pro-preview"],
        defaultProvider: "google",
        expected: { provider: "google", model: "gemini-3.1-pro-preview" },
      },
      {
        name: "normalizes retired gemini cli 3 pro preview ids",
        variants: ["google-gemini-cli/gemini-3-pro-preview"],
        defaultProvider: "google",
        expected: { provider: "google-gemini-cli", model: "gemini-3.1-pro-preview" },
      },
      {
        name: "keeps stable GA gemini 3.1 flash-lite ids",
        variants: ["google/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
        defaultProvider: "google",
        expected: { provider: "google", model: "gemini-3.1-flash-lite" },
      },
      {
        name: "preserves provider-owned xai grok 4.20 beta ids",
        variants: [
          "xai/grok-4.20-experimental-beta-0304-reasoning",
          "grok-4.20-experimental-beta-0304-reasoning",
        ],
        defaultProvider: "xai",
        expected: { provider: "xai", model: "grok-4.20-experimental-beta-0304-reasoning" },
      },
      {
        name: "keeps OpenAI codex refs on the openai provider",
        variants: ["openai/gpt-5.4", "gpt-5.4"],
        defaultProvider: "openai",
        expected: { provider: "openai", model: "gpt-5.4" },
      },
      {
        name: "normalizes the openrouter:auto compatibility alias",
        variants: ["openrouter:auto"],
        defaultProvider: "anthropic",
        expected: { provider: "openrouter", model: "openrouter/auto" },
      },
      {
        name: "preserves openrouter native model prefixes",
        variants: ["openrouter/aurora-alpha"],
        defaultProvider: "openai",
        expected: { provider: "openrouter", model: "openrouter/aurora-alpha" },
      },
      {
        name: "passes through openrouter upstream provider ids",
        variants: ["openrouter/anthropic/claude-sonnet-4-6"],
        defaultProvider: "openai",
        expected: { provider: "openrouter", model: "anthropic/claude-sonnet-4-6" },
      },
      {
        name: "strips duplicate Hugging Face provider prefixes",
        variants: ["huggingface/deepseek-ai/DeepSeek-R1"],
        defaultProvider: "huggingface",
        expected: { provider: "huggingface", model: "deepseek-ai/DeepSeek-R1" },
      },
      {
        name: "normalizes Vercel Claude shorthand to anthropic-prefixed model ids",
        variants: ["vercel-ai-gateway/claude-opus-4.6"],
        defaultProvider: "openai",
        expected: { provider: "vercel-ai-gateway", model: "anthropic/claude-opus-4.6" },
      },
      {
        name: "normalizes Vercel Anthropic aliases without double-prefixing",
        variants: ["vercel-ai-gateway/opus-4.6"],
        defaultProvider: "openai",
        expected: { provider: "vercel-ai-gateway", model: "anthropic/claude-opus-4-6" },
      },
      {
        name: "keeps already-prefixed Vercel Anthropic models unchanged",
        variants: ["vercel-ai-gateway/anthropic/claude-opus-4.6"],
        defaultProvider: "openai",
        expected: { provider: "vercel-ai-gateway", model: "anthropic/claude-opus-4.6" },
      },
      {
        name: "passes through non-Claude Vercel model ids unchanged",
        variants: ["vercel-ai-gateway/openai/gpt-5.4"],
        defaultProvider: "openai",
        expected: { provider: "vercel-ai-gateway", model: "openai/gpt-5.4" },
      },
      {
        name: "keeps already-suffixed codex variants unchanged",
        variants: ["openai/gpt-5.4-codex-codex"],
        defaultProvider: "anthropic",
        expected: { provider: "openai", model: "gpt-5.4-codex-codex" },
      },
      {
        name: "keeps stable GA gemini 3.1 flash-lite ids for google-vertex",
        variants: ["google-vertex/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
        defaultProvider: "google-vertex",
        expected: { provider: "google-vertex", model: "gemini-3.1-flash-lite" },
      },
    ];

    it("parses and normalizes provider/model refs", () => {
      for (const { variants, defaultProvider, expected } of parseModelRefCases) {
        expectParsedModelVariants(variants, defaultProvider, expected);
      }
    });

    it("round-trips normalized refs through modelKey", () => {
      const parsed = parseModelRef(" opus-4.6 ", "anthropic", {
        allowPluginNormalization: false,
      });
      expect(parsed).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
      expect(modelKey(parsed?.provider ?? "", parsed?.model ?? "")).toBe(
        "anthropic/claude-opus-4-6",
      );
    });
    it("returns null for invalid refs", () => {
      for (const raw of ["", "  ", "/", "anthropic/", "/model"]) {
        expect(
          parseModelRef(raw, "anthropic", { allowPluginNormalization: false }),
          raw,
        ).toBeNull();
      }
    });
  });

  describe("resolvePersistedModelRef", () => {
    it.each([
      {
        name: "splits legacy combined refs when provider is not stored separately",
        params: {
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        },
        expected: {
          provider: "ollama-beelink2",
          model: "qwen2.5-coder:7b",
        },
      },
      {
        name: "preserves explicit runtime provider for vendor-prefixed model ids",
        params: {
          defaultProvider: "anthropic",
          runtimeProvider: "openrouter",
          runtimeModel: "anthropic/claude-haiku-4.5",
        },
        expected: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-4.5",
        },
      },
      {
        name: "preserves explicit override provider ids without reparsing runtime semantics",
        params: {
          defaultProvider: "anthropic",
          overrideProvider: "kimi-coding",
          overrideModel: "kimi-code",
        },
        expected: {
          provider: "kimi-coding",
          model: "kimi-code",
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(resolvePersistedModelRef(params)).toEqual(expected);
    });

    it("ignores malformed persisted model fields and tolerates a missing default provider", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: undefined,
          runtimeProvider: { provider: "openai" },
          runtimeModel: false,
          overrideProvider: ["anthropic"],
          overrideModel: 123,
        }),
      ).toBeNull();
    });
  });

  describe("resolvePersistedOverrideModelRef", () => {
    it.each([
      {
        name: "splits legacy combined override refs when provider is not stored separately",
        params: {
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        },
        expected: {
          provider: "ollama-beelink2",
          model: "qwen2.5-coder:7b",
        },
      },
      {
        name: "preserves explicit override provider ids without reparsing away wrapper semantics",
        params: {
          defaultProvider: "anthropic",
          overrideProvider: "kimi-coding",
          overrideModel: "kimi-code",
        },
        expected: {
          provider: "kimi-coding",
          model: "kimi-code",
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(resolvePersistedOverrideModelRef(params)).toEqual(expected);
    });

    it("ignores malformed persisted override fields", () => {
      expect(
        resolvePersistedOverrideModelRef({
          defaultProvider: undefined,
          overrideProvider: ["anthropic"],
          overrideModel: 123,
        }),
      ).toBeNull();
    });
  });

  describe("resolvePersistedSelectedModelRef", () => {
    it.each([
      {
        name: "prefers explicit overrides ahead of runtime model fields",
        params: {
          defaultProvider: "anthropic",
          runtimeProvider: "openai",
          runtimeModel: "gpt-5.4",
          overrideProvider: "anthropic",
          overrideModel: "claude-opus-4-6",
        },
        expected: {
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
      },
      {
        name: "preserves explicit wrapper providers for vendor-prefixed override models",
        params: {
          defaultProvider: "anthropic",
          runtimeProvider: "openrouter",
          runtimeModel: "openrouter/free",
          overrideProvider: "openrouter",
          overrideModel: "anthropic/claude-haiku-4.5",
        },
        expected: {
          provider: "openrouter",
          model: "anthropic/claude-haiku-4.5",
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(resolvePersistedSelectedModelRef(params)).toEqual(expected);
    });

    it("ignores malformed persisted model metadata instead of throwing", () => {
      expect(
        resolvePersistedSelectedModelRef({
          defaultProvider: "anthropic",
          runtimeProvider: { provider: "openai" },
          runtimeModel: false,
          overrideProvider: ["openrouter"],
          overrideModel: 123,
        }),
      ).toBeNull();
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it.each([
      {
        name: "infers provider when configured model match is unique",
        cfg: createProviderInferenceAllowlistConfig("anthropic/claude-sonnet-4-6"),
        model: "claude-sonnet-4-6",
        expected: "anthropic",
      },
      {
        name: "infers provider for slash-containing model id when allowlist match is unique",
        cfg: createProviderInferenceAllowlistConfig(
          "vercel-ai-gateway/anthropic/claude-sonnet-4-6",
        ),
        model: "anthropic/claude-sonnet-4-6",
        expected: "vercel-ai-gateway",
      },
      {
        name: "infers provider from configured provider catalogs when allowlist is absent",
        cfg: createProviderInferenceCatalogConfig({ "qwen-dashscope": ["qwen-max"] }),
        model: "qwen-max",
        expected: "qwen-dashscope",
      },
      {
        name: "infers provider from raw configured ids when manifest policies add prefixes",
        cfg: createProviderInferenceCatalogConfig({ nvidia: ["llama-fast"] }),
        model: "llama-fast",
        expected: "nvidia",
      },
      {
        name: "infers Google provider from canonicalized configured provider catalogs",
        cfg: createProviderInferenceCatalogConfig({ google: ["gemini-3-pro-preview"] }),
        model: "gemini-3.1-pro-preview",
        expected: "google",
      },
      {
        name: "infers proxy providers from canonicalized nested Google catalog ids",
        cfg: createProviderInferenceCatalogConfig({
          kilocode: ["google/gemini-3-pro-preview"],
        }),
        model: "google/gemini-3.1-pro-preview",
        expected: "kilocode",
      },
    ])("$name", ({ cfg, model, expected }) => {
      expect(inferUniqueProviderFromConfiguredModels({ cfg, model })).toBe(expected);
    });

    it.each([
      {
        name: "returns undefined when configured matches are ambiguous",
        cfg: createProviderInferenceAllowlistConfig(
          "anthropic/claude-sonnet-4-6",
          "minimax/claude-sonnet-4-6",
        ),
        model: "claude-sonnet-4-6",
      },
      {
        name: "returns undefined for provider-prefixed model ids",
        cfg: createProviderInferenceAllowlistConfig("anthropic/claude-sonnet-4-6"),
        model: "anthropic/claude-sonnet-4-6",
      },
      {
        name: "returns undefined when provider catalog matches are ambiguous",
        cfg: createProviderInferenceCatalogConfig({
          "qwen-dashscope": ["qwen-max"],
          qwen: ["qwen-max"],
        }),
        model: "qwen-max",
      },
    ])("$name", ({ cfg, model }) => {
      expect(inferUniqueProviderFromConfiguredModels({ cfg, model })).toBeUndefined();
    });

    it("prefers a unique agent match over global and provider-config collisions", () => {
      const cfg = {
        agents: {
          defaults: { models: { "openai/shared-model": {} } },
          entries: {
            worker: { models: { "anthropic/shared-model": {} } },
          },
        },
        models: {
          providers: { minimax: { models: [{ id: "shared-model" }] } },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({ cfg, agentId: "worker", model: "shared-model" }),
      ).toBe("anthropic");
    });

    it("keeps ambiguous agent matches unresolved without falling back globally", () => {
      const cfg = {
        agents: {
          defaults: { models: { "openai/shared-model": {} } },
          entries: {
            worker: {
              models: {
                "anthropic/shared-model": {},
                "minimax/shared-model": {},
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({ cfg, agentId: "worker", model: "shared-model" }),
      ).toBeUndefined();
    });
  });

  describe("buildConfiguredModelCatalog", () => {
    it.each([
      {
        name: "emits canonical Google Gemini 3.1 provider model ids",
        provider: "google",
        configuredId: "gemini-3-pro-preview",
        expectedId: "gemini-3.1-pro-preview",
      },
      {
        name: "emits canonical nested Google Gemini 3.1 ids from proxy provider catalog rows",
        provider: "kilocode",
        configuredId: "google/gemini-3-pro-preview",
        expectedId: "google/gemini-3.1-pro-preview",
      },
    ])("$name", ({ provider, configuredId, expectedId }) => {
      const cfg = createConfiguredModelRefConfig({
        providers: {
          [provider]: {
            models: [{ id: configuredId, name: "Gemini 3 Pro" }],
          },
        },
      });
      const model = buildConfiguredModelCatalog({ cfg }).find(
        (entry) => entry.provider === provider && entry.id === expectedId,
      );

      expect(model?.provider).toBe(provider);
      expect(model?.id).toBe(expectedId);
      expect(model?.name).toBe("Gemini 3 Pro");
    });

    it("carries configured model compat into catalog entries for provider policy", () => {
      const cfg = {
        models: {
          providers: {
            vllm: {
              models: [
                {
                  id: "Qwen/Qwen3-8B",
                  name: "Qwen 3 8B",
                  reasoning: true,
                  thinkingLevelMap: { off: null, max: "max" },
                  compat: {
                    thinkingFormat: "qwen-chat-template",
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const model = buildConfiguredModelCatalog({ cfg }).find(
        (entry) => entry.provider === "vllm" && entry.id === "Qwen/Qwen3-8B",
      );
      expect(model?.compat).toEqual({ thinkingFormat: "qwen-chat-template" });
      expect(model?.reasoning).toBe(true);
      expect(model?.configuredReasoning).toBe(true);
      expect(model?.thinkingLevelMap).toEqual({ off: null, max: "max" });
    });

    it("carries configured model params into catalog entries for provider policy", () => {
      const cfg = {
        models: {
          providers: {
            "amazon-bedrock": {
              models: [
                {
                  id: "company-fable",
                  name: "Company Fable",
                  params: {
                    canonicalModelId: "claude-fable-5",
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const model = buildConfiguredModelCatalog({ cfg }).find(
        (entry) => entry.provider === "amazon-bedrock" && entry.id === "company-fable",
      );
      expect(model?.params).toEqual({ canonicalModelId: "claude-fable-5" });
    });

    it("does not infer reasoning from non-vLLM thinking compat", () => {
      const cfg = {
        models: {
          providers: {
            custom: {
              models: [
                {
                  id: "custom-reasoning",
                  name: "Custom Reasoning",
                  compat: {
                    thinkingFormat: "together",
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const model = buildConfiguredModelCatalog({ cfg }).find(
        (entry) => entry.provider === "custom" && entry.id === "custom-reasoning",
      );
      expect(model?.compat).toEqual({ thinkingFormat: "together" });
      expect(model?.reasoning).toBeUndefined();
    });
  });

  describe("buildModelAliasIndex", () => {
    it("should build alias index from config", () => {
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-3-5-sonnet": { alias: "fast" },
              "openai/gpt-4o": { alias: "smart" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "anthropic",
      });

      expect(index.byAlias.get("fast")?.ref).toEqual({
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      expect(index.byAlias.get("smart")?.ref).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(index.byKey.get(modelKey("anthropic", "claude-3-5-sonnet"))).toEqual(["fast"]);
    });

    it("indexes duplicate aliases by provider", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "lmstudio-moe/qwen3.6-35b-a3b": { alias: "Local" },
              "lmstudio-dense/qwen3.6-27b": { alias: "Local" },
            },
          },
        },
      } as OpenClawConfig;

      const index = buildModelAliasIndex({ cfg, defaultProvider: "openai" });

      expect(index.byProviderAlias?.get("lmstudio-moe/local")?.ref).toEqual({
        provider: "lmstudio-moe",
        model: "qwen3.6-35b-a3b",
      });
      expect(index.byProviderAlias?.get("lmstudio-dense/local")?.ref).toEqual({
        provider: "lmstudio-dense",
        model: "qwen3.6-27b",
      });
    });

    it.each([
      {
        name: "inherits the global alias when agent metadata omits alias",
        agentMetadata: { agentRuntime: { id: "codex" } },
        expectedAlias: "global-luna",
      },
      {
        name: "replaces the global alias with an explicit agent alias",
        agentMetadata: { alias: "worker-luna" },
        expectedAlias: "worker-luna",
      },
      {
        name: "disables the global alias with an explicit empty agent alias",
        agentMetadata: { alias: "" },
        expectedAlias: undefined,
      },
    ])("$name", ({ agentMetadata, expectedAlias }) => {
      const cfg = {
        agents: {
          defaults: {
            models: { "openai/gpt-5.6-luna": { alias: "global-luna" } },
          },
          entries: {
            worker: { models: { "openai/gpt-5.6-luna": agentMetadata } },
          },
        },
      } as OpenClawConfig;

      const index = buildModelAliasIndex({
        cfg,
        agentId: "worker",
        defaultProvider: "openai",
      });

      expect(index.byKey.get("openai/gpt-5.6-luna")?.at(-1)).toBe(expectedAlias);
      expect(index.byAlias.get("global-luna")?.ref).toEqual(
        expectedAlias === "global-luna" ? { provider: "openai", model: "gpt-5.6-luna" } : undefined,
      );
    });

    it("preserves another model's provider-qualified duplicate alias during replacement", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-a": { alias: "shared" },
              "openai/gpt-b": { alias: "shared" },
            },
          },
          entries: {
            worker: { models: { "openai/gpt-a": { alias: "worker-a" } } },
          },
        },
      } as OpenClawConfig;

      const index = buildModelAliasIndex({
        cfg,
        agentId: "worker",
        defaultProvider: "openai",
      });

      expect(index.byProviderAlias?.get("openai/shared")?.ref).toEqual({
        provider: "openai",
        model: "gpt-b",
      });
      expect(index.byProviderAlias?.get("openai/worker-a")?.ref).toEqual({
        provider: "openai",
        model: "gpt-a",
      });
    });

    it("does not normalize configured model keys that have no alias", () => {
      providerModelNormalizationMock.normalizeProviderModelIdWithRuntime.mockClear();
      const models = Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`openai/gpt-5.5-aliasless-${index}`, {}]),
      );
      const cfg: Partial<OpenClawConfig> = {
        agents: {
          defaults: {
            models: {
              ...models,
              "openai/gpt-5.5-mini": { alias: "mini" },
            },
          },
        },
      };

      const index = buildModelAliasIndex({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "openai",
      });

      expect(index.byAlias.get("mini")?.ref).toEqual({
        provider: "openai",
        model: "gpt-5.5-mini",
      });
      expect(
        providerModelNormalizationMock.normalizeProviderModelIdWithRuntime,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildAllowedModelSet", () => {
    it("keeps explicitly allowlisted models even when missing from bundled catalog", () => {
      const result = buildAllowedModelSet({
        cfg: EXPLICIT_ALLOWLIST_CONFIG,
        catalog: BUNDLED_ALLOWLIST_CATALOG,
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedCatalog).toEqual([
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.5",
          alias: "sonnet",
        },
      ]);
    });

    it("overlays configured provider metadata and alias onto matching catalog entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-test-z" },
            models: {
              "openai/gpt-test-z": { alias: "GPT Test Z Alias" },
            },
            modelPolicy: { allow: ["openai/gpt-test-z"] },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [
                {
                  id: "gpt-test-z",
                  name: "Configured GPT Test Z",
                  contextWindow: 64_000,
                  compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [{ provider: "openai", id: "gpt-test-z", name: "gpt-test-z" }],
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        {
          provider: "openai",
          id: "gpt-test-z",
          name: "Configured GPT Test Z",
          alias: "GPT Test Z Alias",
          contextWindow: 64_000,
          compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        },
      ]);
    });

    it("keeps compat catalog-owned while overlaying metadata after manifest normalization", () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            nvidia: {
              models: [
                {
                  id: "llama-fast",
                  name: "Configured Llama Fast",
                  contextWindow: 128_000,
                  reasoning: true,
                  compat: { thinkingFormat: "qwen" },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [{ provider: "nvidia", id: "nvidia/llama-fast", name: "Runtime Llama Fast" }],
        defaultProvider: "anthropic",
      });

      expect(result.allowedCatalog).toEqual([
        {
          provider: "nvidia",
          id: "nvidia/llama-fast",
          name: "Configured Llama Fast",
          contextWindow: 128_000,
          reasoning: true,
          configuredReasoning: true,
        },
      ]);
    });

    it("keeps configured provider models visible when the catalog is otherwise allow-any", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "ollama/existing" },
          },
        },
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              apiKey: "ollama-local",
              models: [
                {
                  id: "glm-5.1:cloud",
                  name: "GLM 5.1 Cloud",
                  contextWindow: 131_072,
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [{ provider: "ollama", id: "existing", name: "Existing" }],
        defaultProvider: "ollama",
        defaultModel: "existing",
      });

      expect(result.allowAny).toBe(true);
      expect(result.allowedCatalog).toEqual([
        { provider: "ollama", id: "existing", name: "Existing" },
        {
          api: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          compat: undefined,
          contextTokens: undefined,
          provider: "ollama",
          id: "glm-5.1:cloud",
          name: "GLM 5.1 Cloud",
          contextWindow: 131_072,
          input: undefined,
          reasoning: undefined,
        },
      ]);
      expect(result.allowedKeys.has("ollama/glm-5.1:cloud")).toBe(true);
    });

    it("allows every discovered catalog model for provider wildcard entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
            modelPolicy: { allow: ["openai/*", "vllm/*"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
          { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
          { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
          { provider: "vllm", id: "local-added-after-startup", name: "Local Added After Startup" },
        ],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
        { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
        { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
        { provider: "vllm", id: "local-added-after-startup", name: "Local Added After Startup" },
      ]);
      expect(result.allowedKeys.has("openai/gpt-5.4-codex")).toBe(true);
      expect(result.allowedKeys.has("openai/gpt-5.5-codex")).toBe(true);
      expect(result.allowedKeys.has("vllm/local-added-after-startup")).toBe(true);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
    });

    it("preserves provider wildcard intent when catalog rows are unavailable", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
            },
            modelPolicy: { allow: ["openai/*"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([]);
      expect(isModelKeyAllowedBySet(result.allowedKeys, "openai/gpt-added-later")).toBe(true);
      expect(isModelKeyAllowedBySet(result.allowedKeys, "anthropic/claude-sonnet-4-6")).toBe(false);
    });

    it("exposes wildcard allow and visible catalog behavior through one policy", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "anthropic/claude-sonnet-4-6": {},
            },
            modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] },
          },
        },
      } as unknown as OpenClawConfig;

      const policy = createModelVisibilityPolicy({
        cfg,
        catalog: [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
          { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
        ],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(policy.hasProviderWildcards).toBe(true);
      expect(policy.allows({ provider: "openai", model: "future-model" })).toBe(true);
      expect(policy.allows({ provider: "vllm", model: "qwen-local" })).toBe(false);
      expect(
        policy.visibleCatalog({
          catalog: [],
          defaultVisibleCatalog: [
            { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
            { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
          ],
        }),
      ).toEqual([
        { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      ]);
    });

    it("keeps exact same-provider entries visible beside wildcard catalog rows", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
              "vllm/manual": {},
            },
            modelPolicy: { allow: ["vllm/*", "vllm/manual"] },
          },
        },
      } as unknown as OpenClawConfig;

      const policy = createModelVisibilityPolicy({
        cfg,
        catalog: [{ provider: "vllm", id: "qwen-local", name: "Qwen Local" }],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(
        policy.visibleCatalog({
          catalog: [],
          defaultVisibleCatalog: [{ provider: "vllm", id: "qwen-local", name: "Qwen Local" }],
        }),
      ).toEqual([
        { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
        { provider: "vllm", id: "manual", name: "manual" },
      ]);
    });

    it("does not re-add a default outside mixed wildcard and exact filters", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "google/gemini-test": {},
            },
            modelPolicy: { allow: ["openai/*", "google/gemini-test"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-codex", name: "GPT Codex" },
          { provider: "google", id: "gemini-test", name: "Gemini Test" },
        ],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result.allowedCatalog).toEqual([
        { provider: "openai", id: "gpt-codex", name: "GPT Codex" },
        { provider: "google", id: "gemini-test", name: "Gemini Test" },
      ]);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
      expect(isModelKeyAllowedBySet(result.allowedKeys, "openai/future-model")).toBe(true);
    });

    it("unions exact model entries with provider wildcard entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "openai/*": {},
            },
            modelPolicy: { allow: ["anthropic/claude-sonnet-4-6", "openai/*"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [
          { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
          { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
          { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
          { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
        ],
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
        { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
        { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      ]);
      expect(result.allowedKeys.has("openai/gpt-5.5-codex")).toBe(true);
      expect(result.allowedKeys.has("vllm/qwen-local")).toBe(false);
    });

    it("matches allowlisted catalog entries with normalized provider and model ids", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "modelscope/Qwen/Qwen3.5-35B-A3B": {},
            },
            modelPolicy: { allow: ["modelscope/Qwen/Qwen3.5-35B-A3B"] },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [
          {
            provider: "modelscope",
            id: "qwen/qwen3.5-35b-a3b",
            name: "Qwen3.5 35B",
            input: ["text", "image"],
          },
        ],
        defaultProvider: "anthropic",
      });

      expect(result.allowedCatalog).toHaveLength(1);
      const allowed = result.allowedCatalog[0];
      expect(allowed?.provider).toBe("modelscope");
      expect(allowed?.id).toBe("qwen/qwen3.5-35b-a3b");
      expect(allowed?.input).toEqual(["text", "image"]);
    });

    it("applies configured provider metadata and alias to synthetic allowlist entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "nvidia/moonshotai/kimi-k2.5" },
            models: {
              "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
            },
            modelPolicy: { allow: ["nvidia/moonshotai/kimi-k2.5"] },
          },
        },
        models: {
          providers: {
            nvidia: {
              baseUrl: "https://nvidia.example.com",
              models: [
                {
                  id: "moonshotai/kimi-k2.5",
                  name: "Kimi K2.5 (Configured)",
                  contextWindow: 32_000,
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "anthropic",
      });

      expect(result.allowAny).toBe(false);
      expect(result.allowedCatalog).toEqual([
        {
          provider: "nvidia",
          id: "moonshotai/kimi-k2.5",
          name: "Kimi K2.5 (Configured)",
          alias: "Kimi K2.5 (NVIDIA)",
          api: undefined,
          baseUrl: "https://nvidia.example.com",
          contextWindow: 32_000,
          contextTokens: undefined,
          input: undefined,
          reasoning: true,
          configuredReasoning: true,
          compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        },
      ]);
    });

    it("keeps fallback models separate from explicit override authorization", () => {
      const cfg = createAgentFallbackConfig({
        fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-3-pro"],
      });

      const result = buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
      expect(result.allowedKeys.has("google/gemini-3.1-pro-preview")).toBe(false);
      expect(result.allowAny).toBe(false);
    });

    it("handles empty fallbacks gracefully", () => {
      const cfg = createAgentFallbackConfig({});

      const result = buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowAny).toBe(false);
    });

    it("keeps per-agent fallback overrides out of explicit selection", () => {
      const cfg = createAgentFallbackConfig({
        fallbacks: ["google/gemini-3-pro"],
        agentFallbacks: ["anthropic/claude-sonnet-4-6"],
      });

      const result = buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        agentId: "coder",
      });

      expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
      expect(result.allowedKeys.has("google/gemini-3.1-pro-preview")).toBe(false);
      expect(result.allowAny).toBe(false);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it.each([
      {
        name: "keeps deprecated catalog refs selectable",
        params: {
          cfg: {} as OpenClawConfig,
          catalog: [
            {
              provider: "openai",
              id: "gpt-5.5",
              name: "GPT-5.5",
              status: "deprecated" as const,
              replacedBy: "gpt-5.6",
            },
          ],
          raw: "openai/gpt-5.5",
          defaultProvider: "openai",
        },
        expected: {
          key: "openai/gpt-5.5",
          ref: { provider: "openai", model: "gpt-5.5" },
        },
      },
      {
        name: "accepts explicit allowlist refs absent from bundled catalog",
        params: {
          cfg: EXPLICIT_ALLOWLIST_CONFIG,
          catalog: BUNDLED_ALLOWLIST_CATALOG,
          raw: "anthropic/claude-sonnet-4-6",
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
        },
        expected: {
          key: "anthropic/claude-sonnet-4-6",
          ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
      {
        name: "keeps legacy CLI runtime refs accepted when canonical runtime refs are also configured",
        params: {
          cfg: {
            agents: {
              defaults: {
                agentRuntime: { id: "claude-cli" },
                model: { primary: "anthropic/claude-sonnet-4-6" },
                models: {
                  "anthropic/claude-sonnet-4-6": {},
                  "claude-cli/claude-sonnet-4-6": {},
                },
              },
            },
          } as OpenClawConfig,
          catalog: BUNDLED_ALLOWLIST_CATALOG,
          raw: "claude-cli/claude-sonnet-4-6",
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
        },
        expected: {
          key: "claude-cli/claude-sonnet-4-6",
          ref: { provider: "claude-cli", model: "claude-sonnet-4-6" },
        },
      },
      {
        name: "strips trailing auth profile suffix before allowlist matching",
        params: {
          cfg: {
            agents: {
              defaults: {
                models: {
                  "openai/@cf/openai/gpt-oss-20b": {},
                },
              },
            },
          } as unknown as OpenClawConfig,
          catalog: [],
          raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
          defaultProvider: "anthropic",
        },
        expected: {
          key: "openai/@cf/openai/gpt-oss-20b",
          ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
        },
      },
      {
        name: "infers provider from allowlist for bare model ids to prevent prefix drift (#48369)",
        params: {
          cfg: {
            agents: {
              defaults: {
                models: {
                  "openai/gpt-5.4": {},
                  "opencode-go/kimi-k2.6": {},
                  "opencode-go/glm-5": {},
                },
              },
            },
          } as OpenClawConfig,
          catalog: [],
          raw: "kimi-k2.6",
          defaultProvider: "openai",
        },
        expected: {
          key: "opencode-go/kimi-k2.6",
          ref: { provider: "opencode-go", model: "kimi-k2.6" },
        },
      },
      {
        name: "resolves slash-form aliases before provider/model parsing",
        params: {
          cfg: {
            agents: {
              defaults: {
                models: {
                  "openai/xiaomi/mimo-v2-pro-mit": {
                    alias: "xiaomi/mimo-v2-pro-mit",
                  },
                },
              },
            },
          } as OpenClawConfig,
          catalog: [],
          raw: "xiaomi/mimo-v2-pro-mit",
          defaultProvider: "openai",
        },
        expected: {
          key: "openai/xiaomi/mimo-v2-pro-mit",
          ref: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(resolveAllowedModelRef(params)).toEqual(expected);
    });
  });

  describe("resolveModelRefFromString", () => {
    it("should resolve from string with alias", () => {
      const index = {
        byAlias: new Map([
          ["fast", { alias: "fast", ref: { provider: "anthropic", model: "sonnet" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "fast",
        defaultProvider: "openai",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "anthropic", model: "sonnet" });
      expect(resolved?.alias).toBe("fast");
    });

    it("should resolve direct ref if no alias match", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/gpt-4",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("resolves provider-qualified aliases without cross-provider collisions", () => {
      const index = buildModelAliasIndex({
        cfg: {
          agents: {
            defaults: {
              models: {
                "lmstudio-moe/qwen3.6-35b-a3b": { alias: "Local" },
                "lmstudio-dense/qwen3.6-27b": { alias: "Local" },
              },
            },
          },
        } as OpenClawConfig,
        defaultProvider: "openai",
      });

      expect(
        resolveModelRefFromString({
          raw: "lmstudio-moe/Local",
          defaultProvider: "openai",
          aliasIndex: index,
        }),
      ).toEqual({
        ref: { provider: "lmstudio-moe", model: "qwen3.6-35b-a3b" },
        alias: "Local",
      });
      expect(
        resolveModelRefFromString({
          raw: "lmstudio-dense/LOCAL",
          defaultProvider: "openai",
          aliasIndex: index,
        }),
      ).toEqual({
        ref: { provider: "lmstudio-dense", model: "qwen3.6-27b" },
        alias: "Local",
      });
    });

    it("prefers slash-form aliases over direct provider/model parsing", () => {
      const index = {
        byAlias: new Map([
          [
            "xiaomi/mimo-v2-pro-mit",
            {
              alias: "xiaomi/mimo-v2-pro-mit",
              ref: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
            },
          ],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "xiaomi/mimo-v2-pro-mit",
        defaultProvider: "anthropic",
        aliasIndex: index,
      });

      expect(resolved?.ref).toEqual({ provider: "openai", model: "xiaomi/mimo-v2-pro-mit" });
      expect(resolved?.alias).toBe("xiaomi/mimo-v2-pro-mit");
    });

    it("strips trailing profile suffix for simple model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "gpt-5@myprofile",
        defaultProvider: "openai",
      });
      expect(resolved?.ref).toEqual({ provider: "openai", model: "gpt-5" });
    });

    it.each([
      {
        title: "strips trailing profile suffix for provider/model refs",
        input: "google/gemini-flash-latest@google:bevfresh",
        expectedProvider: "google",
        expectedModel: "gemini-flash-latest",
      },
      {
        title: "preserves Cloudflare @cf model segments",
        input: "openai/@cf/openai/gpt-oss-20b",
        expectedProvider: "openai",
        expectedModel: "@cf/openai/gpt-oss-20b",
      },
      {
        title: "preserves OpenRouter @preset model segments",
        input: "openrouter/@preset/kimi-2-5",
        expectedProvider: "openrouter",
        expectedModel: "@preset/kimi-2-5",
      },
      {
        title: "splits trailing profile suffix after OpenRouter preset paths",
        input: "openrouter/@preset/kimi-2-5@work",
        expectedProvider: "openrouter",
        expectedModel: "@preset/kimi-2-5",
      },
    ])("$title", ({ input, expectedProvider, expectedModel }) => {
      const resolved = resolveModelRefFromString({
        raw: input,
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: expectedProvider,
        model: expectedModel,
      });
    });

    it("preserves LM Studio @iq* quant suffixes", () => {
      const resolved = resolveModelRefFromString({
        raw: "lmstudio/qwen3.6-27b@iq3_xxs",
        defaultProvider: "anthropic",
      });

      expect(resolved?.ref).toEqual({
        provider: "lmstudio",
        model: "qwen3.6-27b@iq3_xxs",
      });
    });

    it("splits trailing profile suffix after LM Studio @iq* quant suffixes", () => {
      const resolved = resolveModelRefFromString({
        raw: "lmstudio/qwen3.6-27b@iq3_xxs@work",
        defaultProvider: "anthropic",
      });

      expect(resolved?.ref).toEqual({
        provider: "lmstudio",
        model: "qwen3.6-27b@iq3_xxs",
      });
    });

    it("strips profile suffix before alias resolution", () => {
      const index = {
        byAlias: new Map([
          ["kimi", { alias: "kimi", ref: { provider: "nvidia", model: "moonshotai/kimi-k2.5" } }],
        ]),
        byKey: new Map(),
      };

      const resolved = resolveModelRefFromString({
        raw: "kimi@nvidia:default",
        defaultProvider: "openai",
        aliasIndex: index,
      });
      expect(resolved?.ref).toEqual({
        provider: "nvidia",
        model: "moonshotai/kimi-k2.5",
      });
      expect(resolved?.alias).toBe("kimi");
    });
  });

  describe("resolveConfiguredModelRef", () => {
    it("should infer the unique provider from configured models for bare defaults", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "claude-opus-4-6" },
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      });

      expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    });

    it("should fall back to the configured default provider and warn if provider is missing for non-alias", async () => {
      const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "claude-3-5-sonnet" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "google",
          defaultModel: "gemini-pro",
        });

        expect(result).toEqual({ provider: "google", model: "claude-3-5-sonnet" });
        expect(
          await warnLogs.findText(
            'Model "claude-3-5-sonnet" specified without provider. Falling back to "google/claude-3-5-sonnet". Please use "google/claude-3-5-sonnet" in your config.',
          ),
        ).toBeDefined();
      } finally {
        warnLogs.cleanup();
      }
    });

    it("sanitizes control characters in providerless-model warnings", async () => {
      const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "\u001B[31mclaude-3-5-sonnet\nspoof" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "google",
          defaultModel: "gemini-pro",
        });

        expect(result).toEqual({
          provider: "google",
          model: "\u001B[31mclaude-3-5-sonnet\nspoof",
        });
        const warning = await warnLogs.findText('Falling back to "google/claude-3-5-sonnet"');
        expect(warning).toContain('Falling back to "google/claude-3-5-sonnet"');
        expect(warning).not.toContain("\u001B");
        expect(warning).not.toContain("\n");
      } finally {
        warnLogs.cleanup();
      }
    });

    it("infers a unique configured provider for bare default model strings", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = {
          agents: {
            defaults: {
              model: { primary: "claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": {},
              },
            },
          },
        } as OpenClawConfig;

        const result = resolveConfiguredModelRef({
          cfg,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
        });

        expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
      }
    });

    it("normalizes bare configured default model strings with manifest policies", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "llama-fast" },
          },
        },
        models: {
          providers: {
            nvidia: {
              models: [{ id: "llama-fast" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      });

      expect(result).toEqual({
        provider: "nvidia",
        model: "nvidia/llama-fast",
      });
    });

    const nemotronProvider = {
      "nemotron-bolt": {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: [{ id: "nemotron-3-super-120b", name: "Nemotron" }],
      },
    };

    it.each([
      {
        name: "keeps exact configured provider refs before alias values that point to them",
        primary: "nemotron-bolt/nemotron-3-super-120b",
        modelEntries: {
          nemotron: { alias: "nemotron-bolt/nemotron-3-super-120b" },
        },
        providers: nemotronProvider,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
      },
      {
        name: "keeps exact configured provider refs before slash-form alias values that point to them",
        primary: "nemotron-bolt/nemotron-3-super-120b",
        modelEntries: {
          "openai/nemotron-bolt/nemotron-3-super-120b": {
            alias: "nemotron-bolt/nemotron-3-super-120b",
          },
        },
        providers: nemotronProvider,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
      },
      {
        name: "keeps built-in provider refs before bare alias values that point to them",
        primary: "anthropic/claude-opus-4-6",
        modelEntries: {
          opus: { alias: "anthropic/claude-opus-4-6" },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        expected: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      {
        name: "prefers slash-form aliases for configured default models",
        primary: "xiaomi/mimo-v2-pro-mit",
        modelEntries: {
          "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" },
        },
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
      },
      {
        name: "prefers slash-form aliases before applying auth profile suffixes",
        primary: "xiaomi/mimo-v2-pro-mit@work",
        modelEntries: {
          "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" },
        },
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
      },
      {
        name: "prefers exact aliases that contain auth-profile-like suffixes",
        primary: "gpt@prod",
        modelEntries: {
          "openai/gpt-5.5": { alias: "gpt@prod" },
        },
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "gpt-5.5" },
      },
      {
        name: "prefers exact slash-form aliases before stripping auth-profile suffixes",
        primary: "anthropic/claude-opus-4-6@prod",
        modelEntries: {
          "openai/gpt-5.5": { alias: "anthropic/claude-opus-4-6@prod" },
        },
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "gpt-5.5" },
      },
      {
        name: "prefers exact auth-profile aliases before configured-provider stripping",
        primary: "nemotron-bolt/nemotron-3-super-120b@prod",
        modelEntries: {
          "openai/gpt-5.5": { alias: "nemotron-bolt/nemotron-3-super-120b@prod" },
        },
        providers: nemotronProvider,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "gpt-5.5" },
      },
      {
        name: "prefers stripped auth-profile aliases before configured-provider stripping",
        primary: "nemotron-bolt/nemotron-3-super-120b@prod",
        modelEntries: {
          "openai/nemotron-bolt/nemotron-3-super-120b": {
            alias: "nemotron-bolt/nemotron-3-super-120b",
          },
        },
        providers: nemotronProvider,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        expected: { provider: "openai", model: "nemotron-bolt/nemotron-3-super-120b" },
      },
    ])("$name", ({ primary, modelEntries, providers, defaultProvider, defaultModel, expected }) => {
      const cfg = createConfiguredModelRefConfig({ primary, modelEntries, providers });
      const result = resolveConfiguredModelRef({ cfg, defaultProvider, defaultModel });

      expect(result).toEqual(expected);
    });

    it("resolves provider-qualified defaults without normalizing every aliasless configured model", () => {
      providerModelNormalizationMock.normalizeProviderModelIdWithRuntime.mockClear();
      const models = Object.fromEntries(
        Array.from({ length: 25 }, (_, index) => [`anthropic/claude-extra-${index}`, {}]),
      );
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models,
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result).toEqual({ provider: "openai", model: "gpt-5.5" });
      expect(
        providerModelNormalizationMock.normalizeProviderModelIdWithRuntime,
      ).toHaveBeenCalledTimes(1);
    });

    it("should use default provider/model if config is empty", () => {
      const cfg: Partial<OpenClawConfig> = {};
      const result = resolveConfiguredModelRef({
        cfg: cfg as OpenClawConfig,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      });
      expect(result).toEqual({ provider: "openai", model: "gpt-4" });
    });

    it("should prefer configured custom provider when default provider is not in models.providers", () => {
      const cfg = createProviderWithModelsConfig("n1n", [
        {
          id: "gpt-5.4",
          name: "GPT 5.4",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ]);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ provider: "n1n", model: "gpt-5.4" });
    });

    it("uses a configured custom provider when the default is only an empty overlay", () => {
      const cfg = {
        models: {
          providers: {
            openai: { baseUrl: "https://openai.example.com/v1", models: [] },
            "local-provider": {
              baseUrl: "http://127.0.0.1:9191/v1",
              models: [
                {
                  id: "local-good",
                  name: "Local Good",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "openai",
          defaultModel: "missing-default-model",
        }),
      ).toEqual({ provider: "local-provider", model: "local-good" });
    });

    it("should keep default provider when it is in models.providers", () => {
      const cfg = createProviderWithModelsConfig("anthropic", [
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 4096,
        },
      ]);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    });

    it.each([
      {
        name: "can skip plugin-backed model normalization for display-only callers",
        primary: "google-vertex/gemini-3.1-flash-lite",
        providers: undefined,
        allowPluginNormalization: false,
        expected: { provider: "google-vertex", model: "gemini-3.1-flash-lite" },
      },
      {
        name: "preserves exact configured provider ids before legacy alias normalization",
        primary: "modelstudio/qwen3.6-plus",
        providers: {
          modelstudio: {
            api: "openai-completions",
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            models: [{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus" }],
          },
        },
        allowPluginNormalization: undefined,
        expected: { provider: "modelstudio", model: "qwen3.6-plus" },
      },
      {
        name: "normalizes retired nested Gemini ids in exact configured provider refs",
        primary: "kilocode/google/gemini-3-pro-preview",
        providers: {
          kilocode: {
            api: "openai-completions",
            baseUrl: "https://kilocode.test/v1",
            models: [{ id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro" }],
          },
        },
        allowPluginNormalization: false,
        expected: { provider: "kilocode", model: "google/gemini-3.1-pro-preview" },
      },
      {
        name: "preserves explicit provider ids when no exact foreign api owner is configured",
        primary: "modelstudio/qwen3.5-plus",
        providers: undefined,
        allowPluginNormalization: undefined,
        expected: { provider: "modelstudio", model: "qwen3.5-plus" },
      },
    ])("$name", ({ primary, providers, allowPluginNormalization, expected }) => {
      const cfg = createConfiguredModelRefConfig({ primary, providers });

      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
          allowPluginNormalization,
        }),
      ).toEqual(expected);
    });

    it("should fall back to hardcoded default when no custom providers have models", () => {
      const cfg = createProviderWithModelsConfig("empty-provider", []);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ provider: "openai", model: "gpt-5.4" });
    });

    it("should warn when specified model cannot be resolved and falls back to default", async () => {
      const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
      try {
        const cfg: Partial<OpenClawConfig> = {
          agents: {
            defaults: {
              model: { primary: "openai/" },
            },
          },
        };

        const result = resolveConfiguredModelRef({
          cfg: cfg as OpenClawConfig,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
        });

        expect(result).toEqual({ provider: "openai", model: "gpt-5.4" });
        expect(
          await warnLogs.findText(
            'Model "openai/" could not be resolved. Falling back to default "openai/gpt-5.4".',
          ),
        ).toBeDefined();
      } finally {
        warnLogs.cleanup();
      }
    });

    it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openrouter:auto" },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result).toEqual({ provider: "openrouter", model: "openrouter/auto" });
    });

    it("resolves openrouter:free to the first configured concrete OpenRouter free model", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openrouter:free" },
            models: {
              "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result).toEqual({
        provider: "openrouter",
        model: "meta-llama/llama-3.3-70b-instruct:free",
      });
    });

    it("prefers an agent-configured OpenRouter free model over the global default", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openrouter:free" },
            models: { "openrouter/global/default:free": {} },
          },
          entries: {
            worker: { models: { "openrouter/agent/preferred:free": {} } },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveConfiguredModelRef({
          cfg,
          agentId: "worker",
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
        }),
      ).toEqual({ provider: "openrouter", model: "agent/preferred:free" });
    });

    it("resolves openrouter:free from configured OpenRouter provider models when needed", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openrouter:free" },
          },
        },
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              models: [
                {
                  id: "deepseek/deepseek-r1-0528:free",
                  name: "DeepSeek R1 Free",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result).toEqual({
        provider: "openrouter",
        model: "deepseek/deepseek-r1-0528:free",
      });
    });

    it("resolves openrouter:free through the allowed-model interactive path", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openrouter/meta-llama/llama-3.3-70b-instruct:free": {},
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        {
          provider: "openrouter",
          id: "meta-llama/llama-3.3-70b-instruct:free",
          name: "Llama 3.3 70B Free",
        },
      ];

      expect(
        resolveAllowedModelRef({
          cfg,
          catalog,
          raw: "openrouter:free",
          defaultProvider: "anthropic",
        }),
      ).toEqual({
        ref: {
          provider: "openrouter",
          model: "meta-llama/llama-3.3-70b-instruct:free",
        },
        key: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      });
    });

    it("treats raw openrouter:free allowlist entries as allowed in the legacy resolver path", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openrouter:free": {},
            },
          },
        },
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              models: [
                {
                  id: "deepseek/deepseek-r1-0528:free",
                  name: "DeepSeek R1 Free",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      const catalog = [
        {
          provider: "openrouter",
          id: "deepseek/deepseek-r1-0528:free",
          name: "DeepSeek R1 Free",
        },
      ];

      expect(
        resolveAllowedModelRef({
          cfg,
          catalog,
          raw: "openrouter:free",
          defaultProvider: "anthropic",
        }),
      ).toEqual({
        ref: {
          provider: "openrouter",
          model: "deepseek/deepseek-r1-0528:free",
        },
        key: "openrouter/deepseek/deepseek-r1-0528:free",
      });
    });
  });

  describe("resolveThinkingDefault", () => {
    it.each([
      {
        name: "prefers per-model params.thinking over global thinkingDefault",
        thinking: "high",
        thinkingDefault: "low" as const,
      },
      {
        name: "accepts per-model params.thinking=adaptive",
        thinking: "adaptive",
        thinkingDefault: undefined,
      },
    ])("$name", ({ thinking, thinkingDefault }) => {
      const cfg = {
        agents: {
          defaults: {
            ...(thinkingDefault ? { thinkingDefault } : {}),
            models: {
              "anthropic/claude-opus-4-6": {
                params: { thinking },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe(thinking);
    });

    it("accepts legacy duplicated OpenRouter keys for per-model thinking", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/hunter-alpha": {
                params: { thinking: "high" },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveThinkingDefault({
          cfg,
          provider: "openrouter",
          model: "openrouter/hunter-alpha",
        }),
      ).toBe("high");
    });

    it.each([
      { name: "treats params.thinking=false as off (#74374)", thinking: false },
      {
        name: 'treats params.thinking="disabled" as off (#74374)',
        thinking: "disabled",
      },
      { name: 'treats params.thinking="none" as off', thinking: "none" },
    ])("$name", ({ thinking }) => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "deepseek/deepseek-v4-pro": {
                params: { thinking },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveThinkingDefault({
          cfg,
          provider: "deepseek",
          model: "deepseek-v4-pro",
        }),
      ).toBe("off");
    });

    it.each([
      {
        name: "defaults explicitly configured Anthropic Opus 5 to high adaptive thinking",
        provider: "anthropic",
        model: "claude-opus-5",
        modelName: "Claude Opus 5",
        expected: "high",
      },
      {
        name: "keeps thinking off by default for explicitly configured Anthropic Opus 4.7",
        provider: "anthropic",
        model: "claude-opus-4-7",
        modelName: "Claude Opus 4.7",
        expected: "off",
      },
      {
        name: "leaves explicitly configured Anthropic Opus 4.8 thinking off by default",
        provider: "anthropic",
        model: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
        expected: "off",
      },
      {
        name: "leaves explicitly configured Anthropic Vertex Opus 4.8 thinking off by default",
        provider: "anthropic-vertex",
        model: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
        expected: "off",
      },
      {
        name: "leaves explicitly configured Claude CLI Opus 4.8 thinking off by default",
        provider: "claude-cli",
        model: "claude-opus-4-8",
        modelName: "Claude Opus 4.8",
        expected: "off",
      },
    ])("$name", ({ provider, model, modelName, expected }) => {
      const cfg = createConfiguredModelRefConfig({ primary: `${provider}/${model}` });

      expect(
        resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog: [{ provider, id: model, name: modelName, reasoning: true }],
        }),
      ).toBe(expected);
    });

    it("uses provider policy thinking defaults when no explicit config overrides them", () => {
      const cfg = {} as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("adaptive");
      expect(
        resolveThinkingDefault({
          cfg,
          provider: "amazon-bedrock",
          model: "us.anthropic.claude-sonnet-4-6",
          catalog: [
            {
              provider: "amazon-bedrock",
              id: "us.anthropic.claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              reasoning: true,
            },
          ],
        }),
      ).toBe("adaptive");
    });

    it("falls back to medium when no provider thinking policy is active", () => {
      const cfg = {} as OpenClawConfig;

      expect(
        resolveThinkingDefault({
          cfg,
          provider: "custom-provider",
          model: "custom-reasoning-model",
          catalog: [
            {
              provider: "custom-provider",
              id: "custom-reasoning-model",
              name: "Custom Reasoning Model",
              reasoning: true,
            },
          ],
        }),
      ).toBe("medium");
    });

    it("honors configured provider models that disable reasoning", () => {
      const cfg = {
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemma-4-26b-a4b-it",
                  name: "Gemma 4 26B",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveThinkingDefault({
          cfg,
          provider: "google",
          model: "gemma-4-26b-a4b-it",
        }),
      ).toBe("off");
    });
  });
});

describe("resolveDefaultModelForAgent", () => {
  it("uses an agent primary model override before the global default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
        list: [
          {
            id: "main",
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveDefaultModelForAgent({ cfg, agentId: "main" })).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("uses agent model metadata to resolve an inherited bare default", () => {
    const cfg = {
      agents: {
        defaults: { model: "claude-sonnet-4-6" },
        entries: {
          worker: {
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "worker-sonnet" },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultModelForAgent({ cfg, agentId: "worker" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
});

describe("normalizeModelSelection", () => {
  it("returns trimmed string for string input", () => {
    expect(normalizeModelSelection("ollama/llama3.2:3b")).toBe("ollama/llama3.2:3b");
  });

  it("returns undefined for empty/whitespace string", () => {
    expect(normalizeModelSelection("")).toBeUndefined();
    expect(normalizeModelSelection("   ")).toBeUndefined();
  });

  it("extracts primary from object", () => {
    expect(normalizeModelSelection({ primary: "google/gemini-2.5-flash" })).toBe(
      "google/gemini-2.5-flash",
    );
  });

  it("returns undefined for object without primary", () => {
    expect(normalizeModelSelection({ fallbacks: ["a"] })).toBeUndefined();
    expect(normalizeModelSelection({})).toBeUndefined();
  });

  it("returns undefined for null/undefined/number", () => {
    expect(normalizeModelSelection(undefined)).toBeUndefined();
    expect(normalizeModelSelection(null)).toBeUndefined();
    expect(normalizeModelSelection(42)).toBeUndefined();
  });
});

describe("resolveSubagentConfiguredModelSelection", () => {
  it.each([
    {
      name: "prefers agents.defaults.subagents.model over the agent primary model",
      agentSubagentModel: undefined,
      expected: "openai/gpt-5.4",
    },
    {
      name: "still prefers agent subagents.model over the agent primary model",
      agentSubagentModel: "google/gemini-2.5-pro",
      expected: "google/gemini-2.5-pro",
    },
  ])("$name", ({ agentSubagentModel, expected }) => {
    const cfg = createSubagentSelectionConfig({
      defaultSubagentModel: "openai/gpt-5.4",
      agents: [
        {
          id: "research",
          model: { primary: "anthropic/claude-opus-4-6" },
          ...(agentSubagentModel ? { subagents: { model: agentSubagentModel } } : {}),
        },
      ],
    });

    expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(expected);
  });

  it("keeps runtime policy attached to the configured default subagent model", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: { model: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
        list: [{ id: "research", model: "anthropic/claude-opus-4-7" }],
      },
    } as OpenClawConfig;

    const resolved = resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" });

    expect(resolved).toBe("anthropic/claude-sonnet-4-6");
    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        config: cfg,
      }),
    ).toEqual({
      runtime: "claude-cli",
      runtimeSource: "model",
    });
  });
});

describe("resolveSubagentSpawnModelSelection", () => {
  it.each([
    {
      name: "resolves a model alias override to its full provider/model ref",
      config: {
        modelEntries: {
          "anthropic/claude-opus-4-6": { alias: "opus" },
          "openai/gpt-5.4": { alias: "gpt" },
        },
      },
      agentId: "main",
      modelOverride: "opus",
      expected: "anthropic/claude-opus-4-6",
    },
    {
      name: "resolves bare configured aliases with the target agent runtime default provider",
      config: {
        defaultPrimary: "openai/gpt-5.4",
        modelEntries: {
          "claude-opus-4-6": { alias: "opus" },
        },
        agents: [{ id: "research", model: "anthropic/claude-sonnet-4-6" }],
      },
      agentId: "research",
      modelOverride: "OPUS",
      expected: "anthropic/claude-opus-4-6",
    },
    {
      name: "resolves alias in configured subagent model",
      config: {
        modelEntries: {
          "openai/gpt-5.4": { alias: "gpt" },
        },
        defaultSubagentModel: "gpt",
      },
      agentId: "main",
      modelOverride: undefined,
      expected: "openai/gpt-5.4",
    },
    {
      name: "resolves profile-qualified aliases without treating the profile as model identity",
      config: {
        modelEntries: {
          "openai/gpt-5.6-luna": { alias: "luna" },
        },
      },
      agentId: "main",
      modelOverride: "luna@openai:test-profile",
      expected: "openai/gpt-5.6-luna@openai:test-profile",
    },
    {
      name: "resolves an alias configured only on the target agent",
      config: {
        modelEntries: { "openai/gpt-5.4": { alias: "global-gpt" } },
        agents: [
          {
            id: "research",
            models: { "anthropic/claude-opus-4-6": { alias: "research-opus" } },
          },
        ],
      },
      agentId: "research",
      modelOverride: "research-opus",
      expected: "anthropic/claude-opus-4-6",
    },
    {
      name: "passes through already-qualified provider/model refs unchanged",
      config: {},
      agentId: "main",
      modelOverride: "openai/gpt-5.4",
      expected: "openai/gpt-5.4",
    },
    {
      name: "falls back to runtime default when no override or config",
      config: {},
      agentId: "main",
      modelOverride: undefined,
      expected: "anthropic/claude-sonnet-4-6",
    },
  ])("$name", ({ config, agentId, modelOverride, expected }) => {
    const cfg = createSubagentSelectionConfig(config);

    expect(resolveSubagentSpawnModelSelection({ cfg, agentId, modelOverride })).toBe(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
