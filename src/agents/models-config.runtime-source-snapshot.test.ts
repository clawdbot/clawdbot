import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  PROVIDER_ENV_API_KEY_CANDIDATES: { openai: ["OPENAI_API_KEY"] },
  resolveProviderEnvApiKeyCandidates: () => ({ openai: ["OPENAI_API_KEY"] }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (config: OpenClawConfig) => config,
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async () => ({}),
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/io.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/io.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/io.js").setRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;
let planOpenClawModelsJsonWithDeps: typeof import("./models-config.plan.js").planOpenClawModelsJsonWithDeps;
let readGeneratedModelsJson: typeof import("./models-config.test-utils.js").readGeneratedModelsJson;
const fixtureSuite = createFixtureSuite("openclaw-models-runtime-source-");

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ clearConfigCache, clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
    await import("../config/io.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
  ({ planOpenClawModelsJsonWithDeps } = await import("./models-config.plan.js"));
  ({ readGeneratedModelsJson } = await import("./models-config.test-utils.js"));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function createOpenAiApiKeySourceConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

function createOpenAiApiKeyRuntimeConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-runtime-resolved", // pragma: allowlist secret
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };
}

function createOpenAiHeaderSourceConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions" as const,
          headers: {
            Authorization: {
              source: "env",
              provider: "default",
              id: "OPENAI_HEADER_TOKEN", // pragma: allowlist secret
            },
            "X-Tenant-Token": {
              source: "file",
              provider: "vault",
              id: "/providers/openai/tenantToken",
            },
          },
          models: [],
        },
      },
    },
  };
}

function createOpenAiHeaderRuntimeConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions" as const,
          headers: {
            Authorization: "Bearer runtime-openai-token",
            "X-Tenant-Token": "runtime-tenant-token",
          },
          models: [],
        },
      },
    },
  };
}

function createOpenAiSourceConfigWithHeadersAndApiKey(): OpenClawConfig {
  const config = createOpenAiHeaderSourceConfig();
  config.models!.providers!.openai.apiKey = {
    source: "env",
    provider: "default",
    id: "OPENAI_API_KEY", // pragma: allowlist secret
  };
  return config;
}

function createOpenAiRuntimeConfigWithHeadersAndApiKey(): OpenClawConfig {
  const config = createOpenAiHeaderRuntimeConfig();
  config.models!.providers!.openai.apiKey = "sk-runtime-resolved"; // pragma: allowlist secret
  return config;
}

function withGatewayTokenMode(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    gateway: {
      auth: {
        mode: "token",
      },
    },
  };
}

async function expectGeneratedProviderApiKey(
  agentDir: string,
  providerId: string,
  expected: string,
) {
  const parsed = await readGeneratedModelsJson<{
    providers: Record<string, { apiKey?: string }>;
  }>(agentDir);
  expect(parsed.providers[providerId]?.apiKey).toBe(expected);
}

async function planGeneratedProviders(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
}) {
  const plan = await planOpenClawModelsJsonWithDeps(
    {
      cfg: params.config,
      sourceConfigForSecrets: params.sourceConfigForSecrets,
      agentDir: "/tmp/openclaw-models-plan",
      env: {},
      existingRaw: "",
      existingParsed: null,
    },
    {
      resolveImplicitProviders: async () => ({}),
    },
  );
  expect(plan.action).toBe("write");
  if (plan.action !== "write") {
    throw new Error(`expected models.json write plan, got ${plan.action}`);
  }
  return JSON.parse(plan.contents).providers as Record<
    string,
    { apiKey?: string; headers?: Record<string, string> }
  >;
}

function expectOpenAiHeaderMarkers(
  providers: Record<string, { headers?: Record<string, string> }>,
) {
  expect(providers.openai?.headers?.Authorization).toBe(
    "secretref-env:OPENAI_HEADER_TOKEN", // pragma: allowlist secret
  );
  expect(providers.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
}

describe("models-config runtime source snapshot", () => {
  it("uses runtime source snapshot markers when passed the active runtime config", async () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: createOpenAiApiKeySourceConfig().models!.providers!.openai,
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: { source: "file", provider: "vault", id: "/moonshot/apiKey" },
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: createOpenAiApiKeyRuntimeConfig().models!.providers!.openai,
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "sk-runtime-moonshot", // pragma: allowlist secret
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    const providers = enforceSourceManagedProviderSecrets({
      providers: runtimeConfig.models!.providers!,
      sourceProviders: sourceConfig.models!.providers,
    })!;
    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    expect(providers.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("projects cloned runtime configs onto source snapshot when preserving provider auth", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      const sourceConfig = createOpenAiApiKeySourceConfig();
      const runtimeConfig = createOpenAiApiKeyRuntimeConfig();
      const clonedRuntimeConfig: OpenClawConfig = {
        ...runtimeConfig,
        agents: {
          defaults: {
            imageModel: "openai/gpt-image-1",
          },
        },
      };

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        await ensureOpenClawModelsJson(clonedRuntimeConfig, agentDir);
        await expectGeneratedProviderApiKey(agentDir, "openai", "OPENAI_API_KEY"); // pragma: allowlist secret
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });

  it("invalidates cached readiness when projected config changes under the same runtime snapshot", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      const sourceConfig = createOpenAiApiKeySourceConfig();
      const runtimeConfig = createOpenAiApiKeyRuntimeConfig();
      const firstCandidate: OpenClawConfig = {
        ...runtimeConfig,
        models: {
          providers: {
            openai: {
              ...runtimeConfig.models!.providers!.openai,
              baseUrl: "https://api.openai.com/v1",
              headers: {
                "X-OpenClaw-Test": "one",
              },
            },
          },
        },
      };
      const secondCandidate: OpenClawConfig = {
        ...runtimeConfig,
        models: {
          providers: {
            openai: {
              ...runtimeConfig.models!.providers!.openai,
              baseUrl: "https://mirror.example/v1",
              headers: {
                "X-OpenClaw-Test": "two",
              },
            },
          },
        },
      };

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        await ensureOpenClawModelsJson(firstCandidate, agentDir);
        let parsed = await readGeneratedModelsJson<{
          providers: Record<
            string,
            { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }
          >;
        }>(agentDir);
        expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
        expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
        expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("one");

        // Header changes still rewrite models.json, but merge mode preserves the existing baseUrl.
        await ensureOpenClawModelsJson(secondCandidate, agentDir);
        parsed = await readGeneratedModelsJson<{
          providers: Record<
            string,
            { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }
          >;
        }>(agentDir);
        expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
        expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
        expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("two");
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });

  it("uses header markers from runtime source snapshot instead of resolved runtime values", async () => {
    const providers = await planGeneratedProviders({
      config: createOpenAiHeaderRuntimeConfig(),
      sourceConfigForSecrets: createOpenAiHeaderSourceConfig(),
    });
    expectOpenAiHeaderMarkers(providers);
  });

  it("keeps source markers when runtime projection is skipped for incompatible top-level shape", async () => {
    const providers = await planGeneratedProviders({
      config: createOpenAiRuntimeConfigWithHeadersAndApiKey(),
      sourceConfigForSecrets: withGatewayTokenMode(createOpenAiSourceConfigWithHeadersAndApiKey()),
    });
    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    expectOpenAiHeaderMarkers(providers);
  });
});
