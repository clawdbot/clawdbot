import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { unsetEnv, withTempEnv } from "./models-config.e2e-harness.js";
import { resolveProvidersForModelsJsonWithDeps } from "./models-config.plan.js";
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
