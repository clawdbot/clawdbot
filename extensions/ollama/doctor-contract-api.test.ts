// Ollama tests cover doctor contract config compatibility.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

type ModelDefinition = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string]["models"][number];

const cloudModel: ModelDefinition = {
  id: "kimi-k2.5:cloud",
  name: "Kimi K2.5 Cloud",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 131072,
  maxTokens: 8192,
};

function readOllamaCloudProvider(config: OpenClawConfig): Record<string, unknown> | undefined {
  return config.models?.providers?.["ollama-cloud"] as Record<string, unknown> | undefined;
}

function legacyLocalConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          apiKey: "OLLAMA_API_KEY",
          models: [cloudModel],
        },
      },
    },
    auth: {
      profiles: {
        "ollama:default": { provider: "ollama", mode: "api_key" },
        "openai:default": { provider: "openai", mode: "api_key" },
      },
    },
    agents: { defaults: { model: { primary: "ollama/kimi-k2.5:cloud" } } },
  } as OpenClawConfig;
}

describe("ollama doctor contract", () => {
  it("detects retired Ollama Cloud provider endpoints", () => {
    expect(legacyConfigRules[0]?.match({ baseUrl: "https://ai.ollama.com" })).toBe(true);
    expect(legacyConfigRules[0]?.match({ baseUrl: "https://ollama.com" })).toBe(false);
  });

  it("migrates the pre-#123190 local marker without replacing its catalog or default", () => {
    const config = legacyLocalConfig();
    const localRule = legacyConfigRules[1];

    expect(
      localRule?.match(
        config.models?.providers?.ollama,
        config as unknown as Record<string, unknown>,
      ),
    ).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Migrated models.providers.ollama.apiKey to ollama-local and removed the obsolete ollama:default auth profile marker.",
    ]);
    expect(result.config.models?.providers?.ollama).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      api: "ollama",
      apiKey: "ollama-local",
      models: [cloudModel],
    });
    expect(result.config.auth?.profiles).toEqual({
      "openai:default": { provider: "openai", mode: "api_key" },
    });
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "ollama/kimi-k2.5:cloud",
    });
    expect(config.models?.providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
    expect(config.auth?.profiles?.["ollama:default"]).toBeDefined();
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("preserves current env-backed marker configs without the exact legacy profile", () => {
    const withoutProfile = legacyLocalConfig();
    delete withoutProfile.auth?.profiles?.["ollama:default"];
    const customizedProfile = legacyLocalConfig();
    customizedProfile.auth!.profiles!["ollama:default"] = {
      provider: "ollama",
      mode: "api_key",
      displayName: "Remote Ollama",
    };

    expect(normalizeCompatibilityConfig({ cfg: withoutProfile })).toEqual({
      config: withoutProfile,
      changes: [],
    });
    expect(normalizeCompatibilityConfig({ cfg: customizedProfile })).toEqual({
      config: customizedProfile,
      changes: [],
    });
  });

  it("migrates retired Ollama Cloud provider baseUrl to the canonical endpoint", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ai.ollama.com",
            api: "ollama",
            models: [cloudModel],
          },
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Updated models.providers.ollama-cloud.baseUrl from the retired Ollama Cloud endpoint to https://ollama.com.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [cloudModel],
    });
    expect(readOllamaCloudProvider(config)?.baseUrl).toBe("https://ai.ollama.com");
  });

  it("removes retired Ollama Cloud provider baseURL aliases when canonical baseUrl is present", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ollama.com",
            baseURL: "https://ai.ollama.com/",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Removed retired models.providers.ollama-cloud.baseURL while preserving models.providers.ollama-cloud.baseUrl.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [],
    });
    expect(readOllamaCloudProvider(config)).toEqual({
      baseUrl: "https://ollama.com",
      baseURL: "https://ai.ollama.com/",
      api: "ollama",
      models: [],
    });
  });

  it("migrates retired Ollama Cloud provider baseURL aliases when canonical baseUrl is blank", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: " ",
            baseURL: "https://ai.ollama.com/",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Updated models.providers.ollama-cloud.baseURL from the retired Ollama Cloud endpoint to https://ollama.com.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      models: [],
    });
    expect(readOllamaCloudProvider(config)).toEqual({
      baseUrl: " ",
      baseURL: "https://ai.ollama.com/",
      api: "ollama",
      models: [],
    });
  });

  it("preserves custom canonical baseUrl when removing retired baseURL aliases", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://custom-ollama-cloud.example.test",
            baseURL: "https://ai.ollama.com/",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Removed retired models.providers.ollama-cloud.baseURL while preserving models.providers.ollama-cloud.baseUrl.",
    ]);
    expect(readOllamaCloudProvider(result.config)).toEqual({
      baseUrl: "https://custom-ollama-cloud.example.test",
      api: "ollama",
      models: [],
    });
    expect(readOllamaCloudProvider(config)).toEqual({
      baseUrl: "https://custom-ollama-cloud.example.test",
      baseURL: "https://ai.ollama.com/",
      api: "ollama",
      models: [],
    });
  });

  it("does not expose credentials or query parameters from the retired URL", () => {
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://user:password@ai.ollama.com/?token=secret",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes.join("\n")).not.toContain("user");
    expect(result.changes.join("\n")).not.toContain("password");
    expect(result.changes.join("\n")).not.toContain("secret");
    expect(readOllamaCloudProvider(result.config)?.baseUrl).toBe("https://ollama.com");
  });
});
