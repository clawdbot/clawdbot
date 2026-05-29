import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import type { ProviderConfig as ModelsProviderConfig } from "./models-config.providers.secrets.js";
import {
  PLUGIN_MODEL_CATALOG_FILE,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "./plugin-model-catalog.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: () => [],
  syncExternalCliCredentials: () => false,
}));

vi.mock("./models-config.providers.js", async () => {
  function createImplicitProvider(baseUrl: string): ModelsProviderConfig {
    return {
      baseUrl,
      api: "openai-completions",
      models: [
        {
          id: "test-model",
          name: "test-model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 4096,
        },
      ],
    };
  }

  return {
    applyNativeStreamingUsageCompat: (providers: Record<string, ModelsProviderConfig>) => providers,
    enforceSourceManagedProviderSecrets: ({
      providers,
    }: {
      providers: Record<string, ModelsProviderConfig>;
    }) => providers,
    normalizeProviders: ({ providers }: { providers: Record<string, ModelsProviderConfig> }) =>
      providers,
    normalizeProviderCatalogModelsForConfig: (providers: Record<string, ModelsProviderConfig>) =>
      providers,
    resolveImplicitProviders: async ({ env }: { env?: NodeJS.ProcessEnv }) => {
      const providers: Record<string, ModelsProviderConfig> = {
        chutes: {
          baseUrl: "https://llm.chutes.ai/v1",
          api: "openai-completions" as const,
          models: [],
        },
        deepseek: {
          ...createImplicitProvider("https://deepseek.example/v1"),
          apiKey: "DEEPSEEK_API_KEY",
        },
        mistral: {
          ...createImplicitProvider("https://mistral.example/v1"),
          apiKey: "MISTRAL_API_KEY",
        },
        xai: {
          ...createImplicitProvider("https://xai.example/v1"),
          apiKey: "XAI_API_KEY",
        },
      };
      if (env?.MINIMAX_API_KEY) {
        providers["minimax"] = {
          ...createImplicitProvider("https://minimax.example/v1"),
          apiKey: "MINIMAX_API_KEY",
        };
      }
      if (env?.SYNTHETIC_API_KEY) {
        providers["synthetic"] = {
          ...createImplicitProvider("https://synthetic.example/v1"),
          apiKey: "SYNTHETIC_API_KEY",
        };
      }
      return providers;
    },
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;

type ParsedProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id: string }>;
};

async function readGeneratedProviders(
  agentDir: string,
): Promise<Record<string, ParsedProviderConfig>> {
  const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
  const parsed = JSON.parse(raw) as { providers?: Record<string, ParsedProviderConfig> };
  const providers = { ...parsed.providers };
  const pluginsDir = path.join(agentDir, "plugins");
  let pluginDirs: Array<import("node:fs").Dirent>;
  try {
    pluginDirs = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return providers;
  }
  for (const entry of pluginDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const catalogPath = path.join(pluginsDir, entry.name, PLUGIN_MODEL_CATALOG_FILE);
    const catalogRaw = await fs.readFile(catalogPath, "utf8").catch(() => undefined);
    if (!catalogRaw) {
      continue;
    }
    const catalog = JSON.parse(catalogRaw) as {
      generatedBy?: string;
      providers?: Record<string, ParsedProviderConfig>;
    };
    if (catalog.generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY) {
      Object.assign(providers, catalog.providers);
    }
  }
  return providers;
}

async function runEnvProviderCase(params: {
  envVar: "MINIMAX_API_KEY" | "SYNTHETIC_API_KEY";
  envValue: string;
  providerKey: "minimax" | "synthetic";
  expectedApiKeyRef: string;
}) {
  const previousValue = process.env[params.envVar];
  process.env[params.envVar] = params.envValue;
  try {
    await ensureOpenClawModelsJson({});

    const provider = (await readGeneratedProviders(resolveDefaultAgentDir({})))[params.providerKey];
    expect(provider?.apiKey).toBe(params.expectedApiKeyRef);
  } finally {
    if (previousValue === undefined) {
      delete process.env[params.envVar];
    } else {
      process.env[params.envVar] = previousValue;
    }
  }
}

describe("models-config", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
    ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
      await import("./models-config.js"));
  });

  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetModelsJsonReadyCacheForTest();
  });

  it("writes marker-backed defaults but skips env-gated providers when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      await withTempEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"], async () => {
        unsetEnv([...MODELS_CONFIG_IMPLICIT_ENV_VARS, "KIMI_API_KEY"]);

        const agentDir = path.join(home, "agent-empty");
        // ensureAuthProfileStore merges the main auth store into non-main dirs; point main at our temp dir.
        process.env.OPENCLAW_AGENT_DIR = agentDir;

        const result = await ensureOpenClawModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        const providers = await readGeneratedProviders(agentDir);

        expect(result.wrote).toBe(true);
        expect(Object.keys(providers).toSorted()).toStrictEqual([
          "chutes",
          "deepseek",
          "mistral",
          "xai",
        ]);
        expect(providers["openai"]).toBeUndefined();
        expect(providers["minimax"]).toBeUndefined();
        expect(providers["synthetic"]).toBeUndefined();
      });
    });
  });

  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const modelPath = path.join(resolveDefaultAgentDir({}), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<
          string,
          {
            baseUrl?: string;
            models?: Array<{
              id?: string;
              cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
            }>;
          }
        >;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
      const model = parsed.providers["custom-proxy"]?.models?.[0];
      expect(model?.id).toBe("llama-3.1-8b");
      expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });
  });

  it("preserves existing generated plugin catalog secrets in merge mode", async () => {
    await withTempHome(async (home) => {
      const agentDir = path.join(home, "agent-plugin-merge");
      const catalogPath = path.join(agentDir, "plugins", "deepseek", PLUGIN_MODEL_CATALOG_FILE);
      await fs.mkdir(path.dirname(catalogPath), { recursive: true });
      await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
      await fs.writeFile(
        catalogPath,
        JSON.stringify(
          {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              deepseek: {
                baseUrl: "https://persisted.example/v1",
                api: "openai-completions",
                apiKey: "persisted-key",
                models: [{ id: "test-model" }],
              },
            },
          },
          null,
          2,
        ),
      );
      const pluginMetadataSnapshot = {
        index: { plugins: [{ pluginId: "deepseek", enabled: true }] },
        normalizePluginId: (pluginId: string) => pluginId,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: {
          providers: new Map([["deepseek", ["deepseek"]]]),
          modelCatalogProviders: new Map([["deepseek", ["deepseek"]]]),
          setupProviders: new Map(),
        },
      } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;

      await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir, {
        pluginMetadataSnapshot,
      });

      const raw = await fs.readFile(catalogPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, ParsedProviderConfig>;
      };
      expect(parsed.providers.deepseek?.baseUrl).toBe("https://persisted.example/v1");
      expect(parsed.providers.deepseek).toBeDefined();
    });
  });

  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "MINIMAX_API_KEY",
        envValue: "sk-minimax-test",
        providerKey: "minimax",
        expectedApiKeyRef: "MINIMAX_API_KEY", // pragma: allowlist secret
      });
    });
  });

  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      await runEnvProviderCase({
        envVar: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-test",
        providerKey: "synthetic",
        expectedApiKeyRef: "SYNTHETIC_API_KEY", // pragma: allowlist secret
      });
    });
  });
});
