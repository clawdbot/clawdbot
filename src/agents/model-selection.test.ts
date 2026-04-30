import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { __testing as setupRegistryRuntimeTesting } from "../plugins/setup-registry.runtime.js";
import {
  buildAllowedModelSet,
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
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
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
  resolveThinkingDefault,
  resolveModelRefFromString,
} from "./model-selection.js";

const EXPLICIT_ALLOWLIST_CONFIG = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: {
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      },
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

const ANTHROPIC_OPUS_47_CATALOG = [
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
  },
];

function resolveAnthropicOpusThinking(cfg: OpenClawConfig) {
  return resolveThinkingDefault({
    cfg,
    provider: "anthropic",
    model: "claude-opus-4-6",
    catalog: ANTHROPIC_OPUS_CATALOG,
  });
}

function resolveAnthropicOpus47Thinking(cfg: OpenClawConfig) {
  return resolveThinkingDefault({
    cfg,
    provider: "anthropic",
    model: "claude-opus-4-7",
    catalog: ANTHROPIC_OPUS_47_CATALOG,
  });
}

function createAgentFallbackConfig(params: {
  primary?: string;
  fallbacks?: string[];
  agentFallbacks?: string[];
}) {
  return {
    agents: {
      defaults: {
        models: {
          "openai/gpt-4o": {},
        },
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

function resolveConfiguredRefForTest(cfg: Partial<OpenClawConfig>) {
  return resolveConfiguredModelRef({
    cfg: cfg as OpenClawConfig,
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
  });
}

describe("model-selection", () => {
  describe("normalizeProviderId", () => {
    it("should normalize provider names", () => {
      expect(normalizeProviderId("Anthropic")).toBe("anthropic");
      expect(normalizeProviderId("Z.ai")).toBe("zai");
      expect(normalizeProviderId("z-ai")).toBe("zai");
      expect(normalizeProviderId("OpenCode-Zen")).toBe("opencode");
      expect(normalizeProviderId("qwen")).toBe("qwen");
      expect(normalizeProviderId("kimi-code")).toBe("kimi");
      expect(normalizeProviderId("kimi-coding")).toBe("kimi");
      expect(normalizeProviderId("bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("aws-bedrock")).toBe("amazon-bedrock");
      expect(normalizeProviderId("amazon-bedrock")).toBe("amazon-bedrock");
    });
  });

  describe("normalizeProviderIdForAuth", () => {
    it("only applies generic provider-id normalization before auth alias lookup", () => {
      expect(normalizeProviderIdForAuth("qwencloud")).toBe("qwen");
      expect(normalizeProviderIdForAuth("openai-codex")).toBe("openai-codex");
      expect(normalizeProviderIdForAuth("openai")).toBe("openai");
    });
  });

  describe("isCliProvider", () => {
    beforeEach(() => {
      setupRegistryRuntimeTesting.resetRuntimeState();
      setupRegistryRuntimeTesting.setRuntimeModuleForTest({
        resolvePluginSetupCliBackend: ({ backend }) =>
          backend === "claude-cli"
            ? {
                pluginId: "anthropic",
                backend: { id: "claude-cli", config: { command: "claude" } },
              }
            : undefined,
      });
    });

    afterEach(() => {
      setupRegistryRuntimeTesting.resetRuntimeState();
    });

    it("returns true for setup-registered cli backends", () => {
      expect(isCliProvider("claude-cli", {} as OpenClawConfig)).toBe(true);
    });

    it("returns false for provider ids", () => {
      expect(isCliProvider("example-cli", {} as OpenClawConfig)).toBe(false);
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
        expect(parseModelRef(raw, defaultProvider), raw).toEqual(expected);
      }
    };

    it.each([
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
        name: "normalizes gemini 3.1 flash-lite ids",
        variants: ["google/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
        defaultProvider: "google",
        expected: { provider: "google", model: "gemini-3.1-flash-lite-preview" },
      },
      {
        name: "normalizes deprecated xai grok 4.20 beta ids",
        variants: [
          "xai/grok-4.20-experimental-beta-0304-reasoning",
          "grok-4.20-experimental-beta-0304-reasoning",
        ],
        defaultProvider: "xai",
        expected: { provider: "xai", model: "grok-4.20-beta-latest-reasoning" },
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
        name: "normalizes gemini 3.1 flash-lite ids for google-vertex",
        variants: ["google-vertex/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
        defaultProvider: "google-vertex",
        expected: { provider: "google-vertex", model: "gemini-3.1-flash-lite-preview" },
      },
    ])("$name", ({ variants, defaultProvider, expected }) => {
      expectParsedModelVariants(variants, defaultProvider, expected);
    });

    it("round-trips normalized refs through modelKey", () => {
      const parsed = parseModelRef(" opus-4.6 ", "anthropic");
      expect(parsed).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
      expect(modelKey(parsed?.provider ?? "", parsed?.model ?? "")).toBe(
        "anthropic/claude-opus-4-6",
      );
    });
    it.each(["", "  ", "/", "anthropic/", "/model"])("returns null for invalid ref %j", (raw) => {
      expect(parseModelRef(raw, "anthropic")).toBeNull();
    });
  });

  describe("resolvePersistedModelRef", () => {
    it("splits legacy combined refs when provider is not stored separately", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        provider: "ollama-beelink2",
        model: "qwen2.5-coder:7b",
      });
    });

    it("preserves explicit runtime provider for vendor-prefixed model ids", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          runtimeProvider: "openrouter",
          runtimeModel: "anthropic/claude-haiku-4.5",
        }),
      ).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      });
    });

    it("normalizes explicit override providers without reparsing runtime semantics", () => {
      expect(
        resolvePersistedModelRef({
          defaultProvider: "anthropic",
          overrideProvider: "kimi-coding",
          overrideModel: "kimi-code",
        }),
      ).toEqual({
        provider: "kimi",
        model: "kimi-code",
      });
    });
  });

  describe("resolvePersistedOverrideModelRef", () => {
    it("splits legacy combined override refs when provider is not stored separately", () => {
      expect(
        resolvePersistedOverrideModelRef({
          defaultProvider: "anthropic",
          overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
        }),
      ).toEqual({
        provider: "ollama-beelink2",
        model: "qwen2.5-coder:7b",
      });
    });

    it("normalizes explicit override providers without reparsing away wrapper semantics", () => {
      expect(
        resolvePersistedOverrideModelRef({
          defaultProvider: "anthropic",
          overrideProvider: "kimi-coding",
          overrideModel: "kimi-code",
        }),
      ).toEqual({
        provider: "kimi",
        model: "kimi-code",
      });
    });
  });

  describe("resolvePersistedSelectedModelRef", () => {
    it("prefers explicit overrides ahead of runtime model fields", () => {
      expect(
        resolvePersistedSelectedModelRef({
          defaultProvider: "anthropic",
          runtimeProvider: "openai-codex",
          runtimeModel: "gpt-5.4",
          overrideProvider: "anthropic",
          overrideModel: "claude-opus-4-6",
        }),
      ).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
    });

    it("preserves explicit wrapper providers for vendor-prefixed override models", () => {
      expect(
        resolvePersistedSelectedModelRef({
          defaultProvider: "anthropic",
          runtimeProvider: "openrouter",
          runtimeModel: "openrouter/free",
          overrideProvider: "openrouter",
          overrideModel: "anthropic/claude-haiku-4.5",
        }),
      ).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      });
    });
  });

  describe("inferUniqueProviderFromConfiguredModels", () => {
    it("infers provider when configured model match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBe("anthropic");
    });

    it("returns undefined when configured matches are ambiguous", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
              "minimax/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for provider-prefixed model ids", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBeUndefined();
    });

    it("infers provider for slash-containing model id when allowlist match is unique", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "anthropic/claude-sonnet-4-6",
        }),
      ).toBe("vercel-ai-gateway");
    });

    it("infers provider from configured provider catalogs when allowlist is absent", () => {
      const cfg = {
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "qwen-max" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "qwen-max",
        }),
      ).toBe("qwen-dashscope");
    });

    it("returns undefined when provider catalog matches are ambiguous", () => {
      const cfg = {
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "qwen-max" }],
            },
            qwen: {
              models: [{ id: "qwen-max" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        inferUniqueProviderFromConfiguredModels({
          cfg,
          model: "qwen-max",
        }),
      ).toBeUndefined();
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
          provider: "ollama",
          id: "glm-5.1:cloud",
          name: "GLM 5.1 Cloud",
          contextWindow: 131_072,
        },
      ]);
      expect(result.allowedKeys.has("ollama/glm-5.1:cloud")).toBe(true);
    });

    it("matches allowlisted catalog entries with normalized provider and model ids", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "modelscope/Qwen/Qwen3.5-35B-A3B": {},
            },
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

      expect(result.allowedCatalog).toEqual([
        expect.objectContaining({
          provider: "modelscope",
          id: "qwen/qwen3.5-35b-a3b",
          input: ["text", "image"],
        }),
      ]);
    });

    it("applies configured provider metadata and alias to synthetic allowlist entries", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "nvidia/moonshotai/kimi-k2.5" },
            models: {
              "nvidia/moonshotai/kimi-k2.5": { alias: "Kimi K2.5 (NVIDIA)" },
            },
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
          contextWindow: 32_000,
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
        },
      ]);
    });

    it("includes fallback models in allowed set", () => {
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
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedKeys.has("google/gemini-3-pro-preview")).toBe(true);
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

    it("prefers per-agent fallback overrides when agentId is provided", () => {
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
      expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(true);
      expect(result.allowedKeys.has("google/gemini-3-pro-preview")).toBe(false);
      expect(result.allowAny).toBe(false);
    });
  });

  describe("resolveAllowedModelRef", () => {
    it("accepts explicit allowlist refs absent from bundled catalog", () => {
      const result = resolveAllowedModelRef({
        cfg: EXPLICIT_ALLOWLIST_CONFIG,
        catalog: BUNDLED_ALLOWLIST_CATALOG,
        raw: "anthropic/claude-sonnet-4-6",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      });

      expect(result).toEqual({
        key: "anthropic/claude-sonnet-4-6",
        ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
      });
    });

    it("strips trailing auth profile suffix before allowlist matching", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              "openai/@cf/openai/gpt-oss-20b": {},
            },
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
        defaultProvider: "anthropic",
      });

      expect(result).toEqual({
        key: "openai/@cf/openai/gpt-oss-20b",
        ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
      });
    });

    it("infers provider from allowlist for bare model ids to prevent prefix drift (#48369)", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {},
              "opencode-go/kimi-k2.6": {},
              "opencode-go/glm-5": {},
            },
          },
        },
      } as OpenClawConfig;

      // When session default is openai-codex, switching to a bare "kimi-k2.6"
      // should resolve to opencode-go/kimi-k2.6, not openai-codex/kimi-k2.6
      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "kimi-k2.6",
        defaultProvider: "openai-codex", // session's current provider
      });

      expect(result).toEqual({
        key: "opencode-go/kimi-k2.6",
        ref: { provider: "opencode-go", model: "kimi-k2.6" },
      });
    });

    it("resolves slash-form aliases before provider/model parsing", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/xiaomi/mimo-v2-pro-mit": {
                alias: "xiaomi/mimo-v2-pro-mit",
              },
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveAllowedModelRef({
        cfg,
        catalog: [],
        raw: "xiaomi/mimo-v2-pro-mit",
        defaultProvider: "openai",
      });

      expect(result).toEqual({
        key: "openai/xiaomi/mimo-v2-pro-mit",
        ref: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
      });
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

    it("strips trailing profile suffix for provider/model refs", () => {
      const resolved = resolveModelRefFromString({
        raw: "google/gemini-flash-latest@google:bevfresh",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "google",
        model: "gemini-flash-latest",
      });
    });

    it("preserves Cloudflare @cf model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openai/@cf/openai/gpt-oss-20b",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openai",
        model: "@cf/openai/gpt-oss-20b",
      });
    });

    it("preserves OpenRouter @preset model segments", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
      });
    });

    it("splits trailing profile suffix after OpenRouter preset paths", () => {
      const resolved = resolveModelRefFromString({
        raw: "openrouter/@preset/kimi-2-5@work",
        defaultProvider: "anthropic",
      });
      expect(resolved?.ref).toEqual({
        provider: "openrouter",
        model: "@preset/kimi-2-5",
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

    it("should fall back to the configured default provider and warn if provider is missing for non-alias", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to "google/claude-3-5-sonnet"'),
        );
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
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

    it("prefers slash-form aliases for configured default models", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "xiaomi/mimo-v2-pro-mit" },
            models: {
              "openai/xiaomi/mimo-v2-pro-mit": {
                alias: "xiaomi/mimo-v2-pro-mit",
              },
            },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      });

      expect(result).toEqual({ provider: "openai", model: "xiaomi/mimo-v2-pro-mit" });
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

    it("can skip plugin-backed model normalization for display-only callers", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "google-vertex/gemini-3.1-flash-lite" },
          },
        },
      } as OpenClawConfig;

      const result = resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        allowPluginNormalization: false,
      });

      expect(result).toEqual({
        provider: "google-vertex",
        model: "gemini-3.1-flash-lite-preview",
      });
    });

    it("preserves exact configured provider ids before legacy alias normalization", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "modelstudio/qwen3.6-plus" },
          },
        },
        models: {
          providers: {
            modelstudio: {
              api: "openai-completions",
              baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
              models: [{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
        }),
      ).toEqual({ provider: "modelstudio", model: "qwen3.6-plus" });
    });

    it("keeps legacy modelstudio aliases when no exact foreign api owner is configured", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "modelstudio/qwen3.5-plus" },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
        }),
      ).toEqual({ provider: "qwen", model: "qwen3.5-plus" });
    });

    it("should fall back to hardcoded default when no custom providers have models", () => {
      const cfg = createProviderWithModelsConfig("empty-provider", []);
      const result = resolveConfiguredRefForTest(cfg);
      expect(result).toEqual({ provider: "openai", model: "gpt-5.4" });
    });

    it("should warn when specified model cannot be resolved and falls back to default", () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to default "openai/gpt-5.4"'),
        );
      } finally {
        warnSpy.mockRestore();
        setLoggerOverride(null);
        resetLogger();
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
    it("prefers per-model params.thinking over global thinkingDefault", () => {
      const cfg = {
        agents: {
          defaults: {
            thinkingDefault: "low",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { thinking: "high" },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("high");
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

    it("accepts per-model params.thinking=adaptive", () => {
      const cfg = {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { thinking: "adaptive" },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("adaptive");
    });

    it("keeps thinking off by default for explicitly configured Anthropic Opus 4.7", () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      } as OpenClawConfig;

      expect(resolveAnthropicOpus47Thinking(cfg)).toBe("off");
    });

    it("falls back to medium when no provider thinking hook is active", () => {
      const cfg = {} as OpenClawConfig;

      expect(resolveAnthropicOpusThinking(cfg)).toBe("medium");

      expect(
        resolveThinkingDefault({
          cfg,
          provider: "amazon-bedrock",
          model: "us.anthropic.claude-sonnet-4-6-v1:0",
          catalog: [
            {
              provider: "amazon-bedrock",
              id: "us.anthropic.claude-sonnet-4-6-v1:0",
              name: "Claude Sonnet 4.6",
              reasoning: true,
            },
          ],
        }),
      ).toBe("medium");
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
  it("prefers the agent primary model over agents.defaults.subagents.model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          subagents: { model: "openai/gpt-5.4" },
        },
        list: [
          {
            id: "research",
            model: { primary: "anthropic/claude-opus-4-6" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("still prefers agent subagents.model over the agent primary model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          subagents: { model: "openai/gpt-5.4" },
        },
        list: [
          {
            id: "research",
            model: { primary: "anthropic/claude-opus-4-6" },
            subagents: { model: "google/gemini-2.5-pro" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(
      "google/gemini-2.5-pro",
    );
  });
});

describe("resolveSubagentSpawnModelSelection", () => {
  it("resolves a model alias override to its full provider/model ref", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "anthropic/claude-opus-4-6": { alias: "opus" },
            "openai/gpt-5.4": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSubagentSpawnModelSelection({ cfg, agentId: "main", modelOverride: "opus" }),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("resolves bare configured aliases with the target agent runtime default provider", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "claude-opus-4-6": { alias: "opus" },
          },
        },
        list: [
          {
            id: "research",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    } as OpenClawConfig;

    expect(
      resolveSubagentSpawnModelSelection({
        cfg,
        agentId: "research",
        modelOverride: "OPUS",
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });

  it("resolves alias in configured subagent model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          models: {
            "openai/gpt-5.4": { alias: "gpt" },
          },
          subagents: { model: "gpt" },
        },
      },
    } as OpenClawConfig;

    expect(resolveSubagentSpawnModelSelection({ cfg, agentId: "main" })).toBe("openai/gpt-5.4");
  });

  it("passes through already-qualified provider/model refs unchanged", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSubagentSpawnModelSelection({
        cfg,
        agentId: "main",
        modelOverride: "openai/gpt-5.4",
      }),
    ).toBe("openai/gpt-5.4");
  });

  it("falls back to runtime default when no override or config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
    } as OpenClawConfig;

    expect(resolveSubagentSpawnModelSelection({ cfg, agentId: "main" })).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});
