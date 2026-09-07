// Arcee tests cover upgrade repair for the shipped OpenRouter onboarding shape.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type ModelDefinition = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string]["models"][number];

function modelDefinition(id: string, name: string): ModelDefinition {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192,
  };
}

const legacyCatalog = [
  modelDefinition("arcee-ai/trinity-large-preview", "Trinity Large Preview"),
  modelDefinition("arcee-ai/trinity-large-thinking", "Trinity Large Thinking"),
];

function shippedOpenRouterConfig(): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "openrouter:default": { provider: "openrouter", mode: "api_key" },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "arcee/trinity-large-thinking",
          fallbacks: ["arcee/trinity-large-preview", "openai/gpt-5.5"],
        },
        models: {
          "arcee/trinity-large-thinking": { alias: "Arcee AI (OpenRouter)" },
          "openai/gpt-5.5": { alias: "Primary fallback" },
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        arcee: {
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-completions",
          models: legacyCatalog,
        },
      },
    },
  } as OpenClawConfig;
}

describe("Arcee doctor contract", () => {
  it("detects only OpenRouter-backed Arcee provider catalogs", () => {
    const rule = legacyConfigRules[0];
    expect(rule?.match?.({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(rule?.match?.({ baseUrl: "https://api.arcee.ai/api/v1" })).toBe(false);
    expect(rule?.message).toContain("openclaw doctor --fix");
  });

  it("migrates the shipped catalog, default, fallbacks, and alias to OpenRouter ownership", () => {
    const config = shippedOpenRouterConfig();
    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Moved the OpenRouter-backed Arcee catalog from models.providers.arcee to models.providers.openrouter and repaired its model references.",
    ]);
    expect(result.config.models?.providers?.arcee).toBeUndefined();
    expect(result.config.models?.providers?.openrouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      models: legacyCatalog,
    });
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "openrouter/arcee-ai/trinity-large-thinking",
      fallbacks: ["openrouter/arcee-ai/trinity-large-preview", "openai/gpt-5.5"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "openrouter/arcee-ai/trinity-large-thinking": { alias: "Arcee AI (OpenRouter)" },
      "openai/gpt-5.5": { alias: "Primary fallback" },
    });
    expect(result.config.auth).toEqual(config.auth);
    expect(config.models?.providers?.arcee).toBeDefined();
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("merges catalog rows into an existing OpenRouter provider without overwriting it", () => {
    const config = shippedOpenRouterConfig();
    if (!config.models?.providers) {
      throw new Error("expected provider config");
    }
    config.models.providers.openrouter = {
      baseUrl: "https://openrouter-proxy.example.test/v1",
      api: "openai-responses",
      models: [
        modelDefinition("arcee-ai/trinity-large-thinking", "Operator override"),
        modelDefinition("other/model", "Other model"),
      ],
    };

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.config.models?.providers?.openrouter).toMatchObject({
      baseUrl: "https://openrouter-proxy.example.test/v1",
      api: "openai-responses",
      models: [
        { id: "arcee-ai/trinity-large-thinking", name: "Operator override" },
        { id: "other/model", name: "Other model" },
        { id: "arcee-ai/trinity-large-preview", name: "Trinity Large Preview" },
      ],
    });
  });

  it("leaves direct Arcee configuration unchanged", () => {
    const config = {
      models: {
        providers: {
          arcee: {
            baseUrl: "https://api.arcee.ai/api/v1",
            api: "openai-completions",
            models: [modelDefinition("trinity-large-thinking", "Trinity Large Thinking")],
          },
        },
      },
    } as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });
});
