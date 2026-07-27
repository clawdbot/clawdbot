// Verifies model reference validation in config surfaces.
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createModelSuppressionRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai", "openai"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-5.3-codex-spark",
              reason:
                "gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
            },
          ],
        },
      },
    ],
  };
}

function createModelNormalizationRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
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
              aliases: { latest: "modern-model" },
              prefixWhenBare: "vendor",
            },
          },
        },
      },
    ],
  };
}

describe("config model reference validation", () => {
  it("rejects statically suppressed provider/model pairs during config validation", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
      },
    ]);
  });

  it("accepts supported openai provider/model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts available openai fallback model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["openai/gpt-5.2-codex", "openai/gpt-5.3-codex"],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("loads model normalization policies when plugin validation is skipped", () => {
    const res = validateConfigObjectWithPlugins(
      {
        models: {
          providers: {
            myproxy: {
              baseUrl: "https://proxy.example/v1",
              apiKey: "sk-test",
              api: "openai-completions",
              models: [
                {
                  id: "latest",
                  name: "Custom latest",
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
      },
      {
        pluginValidation: "skip",
        loadPluginMetadataSnapshot: () => ({
          manifestRegistry: createModelNormalizationRegistry(),
        }),
      },
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.models?.providers?.myproxy?.models?.[0]?.id).toBe("vendor/modern-model");
    }
  });
});
