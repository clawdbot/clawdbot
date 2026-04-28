import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { unsetEnv, withTempEnv } from "./models-config.e2e-harness.js";
import {
  planOpenClawModelsJsonWithDeps,
  resolveProvidersForModelsJsonWithDeps,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const TEST_ENV_VAR = "OPENCLAW_MODELS_CONFIG_TEST_ENV";

function createImplicitOpenRouterProvider(): ProviderConfig {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: "OPENROUTER_API_KEY",
    models: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

async function resolveProvidersForConfigEnvTest(params: {
  cfg: OpenClawConfig;
  onResolveImplicitProviders: (env: NodeJS.ProcessEnv) => void;
}) {
  const env = createConfigRuntimeEnv(params.cfg);
  return await resolveProvidersForModelsJsonWithDeps(
    {
      cfg: params.cfg,
      agentDir: "/tmp/openclaw-models-config-env-vars-test",
      env,
    },
    {
      resolveImplicitProviders: async ({ env: discoveryEnv }) => {
        params.onResolveImplicitProviders(discoveryEnv);
        return {
          openrouter: createImplicitOpenRouterProvider(),
        };
      },
    },
  );
}

function createConfigEnvVarsConfig(): OpenClawConfig {
  return {
    models: { providers: {} },
    env: {
      vars: {
        OPENROUTER_API_KEY: "from-config", // pragma: allowlist secret
        [TEST_ENV_VAR]: "from-config",
      },
    },
  };
}

async function resolveProvidersAndCaptureDiscoveryEnv(cfg: OpenClawConfig) {
  let discoveryEnv: NodeJS.ProcessEnv | undefined;
  const providers = await resolveProvidersForConfigEnvTest({
    cfg,
    onResolveImplicitProviders: (env) => {
      discoveryEnv = env;
    },
  });
  return { discoveryEnv, providers };
}

describe("models-config", () => {
  it("threads plugin metadata snapshots into implicit provider discovery", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("threads workspace scope into implicit provider discovery", async () => {
    let observedWorkspaceDir: string | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        workspaceDir: "/tmp/openclaw-workspace",
      },
      {
        resolveImplicitProviders: async ({ workspaceDir }) => {
          observedWorkspaceDir = workspaceDir;
          return {};
        },
      },
    );

    expect(observedWorkspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("threads startup provider discovery scope into implicit provider discovery", async () => {
    let observedProviderIds: readonly string[] | undefined;
    let observedTimeoutMs: number | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
      },
      {
        resolveImplicitProviders: async ({
          providerDiscoveryProviderIds,
          providerDiscoveryTimeoutMs,
        }) => {
          observedProviderIds = providerDiscoveryProviderIds;
          observedTimeoutMs = providerDiscoveryTimeoutMs;
          return {};
        },
      },
    );

    expect(observedProviderIds).toEqual(["openai"]);
    expect(observedTimeoutMs).toBe(5000);
  });

  it("threads plugin metadata snapshots through models.json planning", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [] },
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: null,
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("uses config env.vars entries for implicit provider discovery without mutating process.env", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      unsetEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR]);
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(process.env[TEST_ENV_VAR]).toBeUndefined();
      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-config");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-config");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
    });
  });

  it("does not overwrite already-set host env vars while ensuring models.json", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      process.env.OPENROUTER_API_KEY = "from-host"; // pragma: allowlist secret
      process.env[TEST_ENV_VAR] = "from-host";
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-host");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-host");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
      expect(process.env.OPENROUTER_API_KEY).toBe("from-host");
      expect(process.env[TEST_ENV_VAR]).toBe("from-host");
    });
  });
});
