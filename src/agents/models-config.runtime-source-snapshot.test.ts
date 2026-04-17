import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withModelsTempHome as withTempHome,
  withTempEnv,
} from "./models-config.e2e-harness.js";

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    applyProviderConfigDefaultsWithPlugin: (config: OpenClawConfig) => config,
    applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
    normalizeProviderConfigWithPlugin: () => undefined,
    resetProviderRuntimeHookCacheForTest: () => undefined,
    resolveProviderConfigApiKeyWithPlugin: () => undefined,
    resolveProviderSyntheticAuthWithPlugin: () => undefined,
  };
});

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

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let loadConfig: typeof import("../config/config.js").loadConfig;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;
let readGeneratedModelsJson: typeof import("./models-config.test-utils.js").readGeneratedModelsJson;

beforeAll(async () => {
  ({ clearConfigCache, clearRuntimeConfigSnapshot, loadConfig, setRuntimeConfigSnapshot } =
    await import("../config/config.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
  ({ readGeneratedModelsJson } = await import("./models-config.test-utils.js"));
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
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

async function withGeneratedModelsFromRuntimeSource(
  params: {
    sourceConfig: OpenClawConfig;
    runtimeConfig: OpenClawConfig;
    candidateConfig?: OpenClawConfig;
  },
  runAssertions: () => Promise<void>,
) {
  await withTempHome(async () => {
    await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      try {
        setRuntimeConfigSnapshot(params.runtimeConfig, params.sourceConfig);
        await ensureOpenClawModelsJson(params.candidateConfig ?? loadConfig());
        await runAssertions();
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });
}

async function expectGeneratedProviderApiKey(providerId: string, expected: string) {
  const parsed = await readGeneratedModelsJson<{
    providers: Record<string, { apiKey?: string }>;
  }>();
  expect(parsed.providers[providerId]?.apiKey).toBe(expected);
}

async function expectGeneratedOpenAiHeaderMarkers() {
  const parsed = await readGeneratedModelsJson<{
    providers: Record<string, { headers?: Record<string, string> }>;
  }>();
  expect(parsed.providers.openai?.headers?.Authorization).toBe(
    "secretref-env:OPENAI_HEADER_TOKEN", // pragma: allowlist secret
  );
  expect(parsed.providers.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
}

describe("models-config runtime source snapshot", () => {
  it("uses runtime source snapshot markers when passed the active runtime config", async () => {
    await withGeneratedModelsFromRuntimeSource(
      {
        sourceConfig: createOpenAiApiKeySourceConfig(),
        runtimeConfig: createOpenAiApiKeyRuntimeConfig(),
      },
      async () => expectGeneratedProviderApiKey("openai", "OPENAI_API_KEY"), // pragma: allowlist secret
    );
  });

  it("uses non-env marker from runtime source snapshot for file refs", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const sourceConfig: OpenClawConfig = {
          models: {
            providers: {
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
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                apiKey: "sk-runtime-moonshot", // pragma: allowlist secret
                api: "openai-completions" as const,
                models: [],
              },
            },
          },
        };

        try {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
          await ensureOpenClawModelsJson(loadConfig());

          const parsed = await readGeneratedModelsJson<{
            providers: Record<string, { apiKey?: string }>;
          }>();
          expect(parsed.providers.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
        } finally {
          clearRuntimeConfigSnapshot();
          clearConfigCache();
        }
      });
    });
  });

  it("projects cloned runtime configs onto source snapshot when preserving provider auth", async () => {
    await withTempHome(async () => {
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
          await ensureOpenClawModelsJson(clonedRuntimeConfig);
          await expectGeneratedProviderApiKey("openai", "OPENAI_API_KEY"); // pragma: allowlist secret
        } finally {
          clearRuntimeConfigSnapshot();
          clearConfigCache();
        }
      });
    });
  });

  it("invalidates cached readiness when projected config changes under the same runtime snapshot", async () => {
    await withTempHome(async () => {
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
          await ensureOpenClawModelsJson(firstCandidate);
          let parsed = await readGeneratedModelsJson<{
            providers: Record<
              string,
              { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }
            >;
          }>();
          expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
          expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
          expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("one");

          // Header changes still rewrite models.json, but merge mode preserves the existing baseUrl.
          await ensureOpenClawModelsJson(secondCandidate);
          parsed = await readGeneratedModelsJson<{
            providers: Record<
              string,
              { baseUrl?: string; apiKey?: string; headers?: Record<string, string> }
            >;
          }>();
          expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
          expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
          expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("two");
        } finally {
          clearRuntimeConfigSnapshot();
          clearConfigCache();
        }
      });
    });
  });

  it("uses header markers from runtime source snapshot instead of resolved runtime values", async () => {
    await withGeneratedModelsFromRuntimeSource(
      {
        sourceConfig: createOpenAiHeaderSourceConfig(),
        runtimeConfig: createOpenAiHeaderRuntimeConfig(),
      },
      expectGeneratedOpenAiHeaderMarkers,
    );
  });

  it("keeps source markers when runtime projection is skipped for incompatible top-level shape", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const sourceConfig = withGatewayTokenMode(createOpenAiApiKeySourceConfig());
        const runtimeConfig = withGatewayTokenMode(createOpenAiApiKeyRuntimeConfig());
        const incompatibleCandidate: OpenClawConfig = {
          ...createOpenAiApiKeyRuntimeConfig(),
        };

        try {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
          await ensureOpenClawModelsJson(incompatibleCandidate);
          await expectGeneratedProviderApiKey("openai", "OPENAI_API_KEY"); // pragma: allowlist secret
        } finally {
          clearRuntimeConfigSnapshot();
          clearConfigCache();
        }
      });
    });
  });

  it("keeps source header markers when runtime projection is skipped for incompatible top-level shape", async () => {
    await withTempHome(async () => {
      await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
        unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
        const sourceConfig = withGatewayTokenMode(createOpenAiHeaderSourceConfig());
        const runtimeConfig = withGatewayTokenMode(createOpenAiHeaderRuntimeConfig());
        const incompatibleCandidate: OpenClawConfig = {
          ...createOpenAiHeaderRuntimeConfig(),
        };

        try {
          setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
          await ensureOpenClawModelsJson(incompatibleCandidate);
          await expectGeneratedOpenAiHeaderMarkers();
        } finally {
          clearRuntimeConfigSnapshot();
          clearConfigCache();
        }
      });
    });
  });
});
