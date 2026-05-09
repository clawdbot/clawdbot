import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import { makeIsolatedEnv } from "./plugin-auto-enable.test-helpers.js";

function makeRegistry(
  plugins: Array<{
    id: string;
    modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
  }>,
): PluginManifestRegistry {
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      channels: [],
      providers: [],
      modelSupport: plugin.modelSupport,
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "config" as const,
      rootDir: `/fake/${plugin.id}`,
      source: `/fake/${plugin.id}/index.js`,
      manifestPath: `/fake/${plugin.id}/openclaw.plugin.json`,
    })),
    diagnostics: [],
  };
}

describe("applyPluginAutoEnable modelSupport", () => {
  it("auto-enables provider plugins from shorthand modelSupport ownership", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          modelSupport: {
            modelPrefixes: ["gpt-", "o1", "o3", "o4"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.changes).toContain("gpt-5.4 model configured, enabled automatically.");
  });

  it("skips ambiguous shorthand model ownership during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
        {
          id: "proxy-openai",
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.config.plugins?.entries?.["proxy-openai"]).toBeUndefined();
    expect(result.changes).toStrictEqual([]);
  });
});
