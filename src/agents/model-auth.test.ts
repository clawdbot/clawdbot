// Verifies provider auth resolution, synthetic auth, and auth header behavior.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import type { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  GCP_VERTEX_CREDENTIALS_MARKER,
  NON_ENV_SECRETREF_MARKER,
} from "./model-auth-markers.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
  loadPluginManifestRegistryForPluginRegistry: () => ({
    diagnostics: [],
    plugins: [
      {
        origin: "bundled",
        nonSecretAuthMarkers: ["gcp-vertex-credentials", "ollama-local"],
        providerAuthEnvVars: {
          ollama: ["OLLAMA_API_KEY"],
        },
      },
    ],
  }),
}));

vi.mock("../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () => [
    {
      pluginDir: "/bundled/anthropic-vertex",
      origin: "bundled",
      manifest: {
        id: "anthropic-vertex",
        nonSecretAuthMarkers: ["gcp-vertex-credentials"],
      },
    },
  ],
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProvider: () => undefined,
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    buildProviderMissingAuthMessageWithPlugin: () => undefined,
    resolveExternalAuthProfilesWithPlugins: () => [],
    shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
      context?: { resolvedApiKey?: string };
    }) => params.context?.resolvedApiKey === "synthetic-defer",
    // Synthetic auth is provider-owned. Tests model local/no-key and plugin
    // config credentials without depending on real plugins.
    resolveProviderSyntheticAuthWithPlugin: (params: {
      provider: string;
      config?: {
        plugins?: {
          enabled?: boolean;
          entries?: Record<
            string,
            {
              enabled?: boolean;
              config?: {
                webSearch?: {
                  apiKey?: unknown;
                };
              };
            }
          >;
        };
        tools?: {
          web?: {
            search?: {
              grok?: {
                apiKey?: unknown;
              };
            };
          };
        };
      };
      modelApi?: string;
      context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
    }) => {
      if (params.provider === "plugin-web") {
        if (
          params.config?.plugins?.enabled === false ||
          params.config?.plugins?.entries?.["plugin-web"]?.enabled === false
        ) {
          return undefined;
        }
        const pluginApiKey =
          params.config?.plugins?.entries?.["plugin-web"]?.config?.webSearch?.apiKey;
        if (typeof pluginApiKey === "string" && pluginApiKey.trim()) {
          return {
            apiKey: pluginApiKey.trim(),
            source: "plugins.entries.plugin-web.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        if (pluginApiKey && typeof pluginApiKey === "object") {
          return {
            apiKey: NON_ENV_SECRETREF_MARKER,
            source: "plugins.entries.plugin-web.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        return undefined;
      }
      if (params.provider === "native-cli") {
        return {
          apiKey: "native-cli-access-token",
          source: "Native CLI auth",
          mode: "oauth" as const,
        };
      }
      const effectiveApi = params.modelApi ?? params.context.providerConfig?.api;
      if (
        effectiveApi === "ollama" &&
        (params.context.providerConfig?.baseUrl?.startsWith("http://192.168.") ||
          params.modelApi === "ollama")
      ) {
        return {
          apiKey: "ollama-local",
          source: `models.providers.${params.provider} (synthetic local key)`,
          mode: "api-key" as const,
        };
      }
      return undefined;
    },
  };
});

let applyAuthHeaderOverride: typeof import("./model-auth.js").applyAuthHeaderOverride;
let applyLocalNoAuthHeaderOverride: typeof import("./model-auth.js").applyLocalNoAuthHeaderOverride;
let applySecretRefHeaderSentinels: typeof import("./model-auth.js").applySecretRefHeaderSentinels;
let createRuntimeProviderAuthLookup: typeof import("./model-auth.js").createRuntimeProviderAuthLookup;
let formatMissingAuthError: typeof import("./model-auth.js").formatMissingAuthError;
let hasAvailableAuthForProvider: typeof import("./model-auth.js").hasAvailableAuthForProvider;
let hasRuntimeAvailableProviderAuth: typeof import("./model-auth.js").hasRuntimeAvailableProviderAuth;
let hasUsableCustomProviderApiKey: typeof import("./model-auth.js").hasUsableCustomProviderApiKey;
let hasSyntheticLocalProviderAuthConfig: typeof import("./model-auth.js").hasSyntheticLocalProviderAuthConfig;
let requireApiKey: typeof import("./model-auth.js").requireApiKey;
let getApiKeyForModel: typeof import("./model-auth.js").getApiKeyForModel;
let resolveApiKeyForProvider: typeof import("./model-auth.js").resolveApiKeyForProvider;
let resolveAwsSdkEnvVarName: typeof import("./model-auth.js").resolveAwsSdkEnvVarName;
let resolveModelAuthMode: typeof import("./model-auth.js").resolveModelAuthMode;
let resolveUsableCustomProviderApiKey: typeof import("./model-auth.js").resolveUsableCustomProviderApiKey;
let cliCredentials: typeof import("./cli-credentials.js");
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let looksLikeSecretSentinel: typeof import("../secrets/sentinel.js").looksLikeSecretSentinel;
let resolveSecretSentinel: typeof import("../secrets/sentinel.js").resolveSecretSentinel;
let setActiveDegradedSecretOwners: typeof import("../secrets/runtime-degraded-state.js").setActiveDegradedSecretOwners;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/runtime-snapshots.js").clearRuntimeAuthProfileStoreSnapshots;
let setRuntimeAuthProfileStoreSnapshot: typeof import("./auth-profiles/runtime-snapshots.js").setRuntimeAuthProfileStoreSnapshot;

beforeAll(async () => {
  vi.resetModules();
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } = await import("../config/config.js"));
  ({ looksLikeSecretSentinel, resolveSecretSentinel } = await import("../secrets/sentinel.js"));
  ({ setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
    await import("./auth-profiles/runtime-snapshots.js"));
  cliCredentials = await import("./cli-credentials.js");
  ({
    applyAuthHeaderOverride,
    applyLocalNoAuthHeaderOverride,
    applySecretRefHeaderSentinels,
    createRuntimeProviderAuthLookup,
    formatMissingAuthError,
    hasAvailableAuthForProvider,
    hasRuntimeAvailableProviderAuth,
    hasSyntheticLocalProviderAuthConfig,
    getApiKeyForModel,
    hasUsableCustomProviderApiKey,
    requireApiKey,
    resolveApiKeyForProvider,
    resolveAwsSdkEnvVarName,
    resolveModelAuthMode,
    resolveUsableCustomProviderApiKey,
  } = await import("./model-auth.js"));
});

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});

describe("createRuntimeProviderAuthLookup", () => {
  it("marks env auth maps as authoritative so hot checks skip setup runtime fallback", () => {
    expect(
      createRuntimeProviderAuthLookup({
        env: {},
      }).envApiKey.skipSetupProviderFallback,
    ).toBe(true);
  });

  it("omits synthetic auth refs when plugin synthetic auth is disabled", () => {
    expect(
      createRuntimeProviderAuthLookup({
        includePluginSyntheticAuth: false,
        env: {},
      }).syntheticAuthProviderRefs,
    ).toBeUndefined();
  });
});

async function withoutEnv<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const snapshot = captureEnv([key]);
  deleteTestEnvValue(key);
  try {
    return await fn();
  } finally {
    snapshot.restore();
  }
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const snapshot = captureEnv([key]);
  setTestEnvValue(key, value);
  try {
    return await fn();
  } finally {
    snapshot.restore();
  }
}

function createCustomProviderConfig(
  baseUrl: string,
  modelId = "llama3",
  modelName = "Llama 3",
): ModelProviderConfig {
  // Minimal custom OpenAI-compatible provider used across auth tests.
  return {
    baseUrl,
    api: "openai-completions" as const,
    models: [
      {
        id: modelId,
        name: modelName,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ],
  };
}

async function resolveCustomProviderAuth(
  provider: string,
  baseUrl: string,
  modelId?: string,
  modelName?: string,
) {
  return resolveApiKeyForProvider({
    provider,
    cfg: {
      models: {
        providers: {
          [provider]: createCustomProviderConfig(baseUrl, modelId, modelName),
        },
      },
    },
  });
}

function expectAuthFields(
  auth: Awaited<ReturnType<typeof resolveApiKeyForProvider>>,
  expected: {
    apiKey: string;
    mode: "api-key" | "oauth";
    source?: string;
  },
) {
  expect(auth.apiKey).toBe(expected.apiKey);
  expect(auth.mode).toBe(expected.mode);
  if (expected.source !== undefined) {
    expect(auth.source).toBe(expected.source);
  }
}

function expectSecretSentinelAuth(
  auth: Awaited<ReturnType<typeof resolveApiKeyForProvider>>,
  expected: { value: string; source: string; mode: "api-key" | "oauth" },
) {
  const apiKey = auth.apiKey;
  expect(apiKey).toBeDefined();
  if (!apiKey) {
    throw new Error("expected model auth API key");
  }
  expect(looksLikeSecretSentinel(apiKey)).toBe(true);
  expect(resolveSecretSentinel(apiKey)).toBe(expected.value);
  expect(auth.source).toBe(expected.source);
  expect(auth.mode).toBe(expected.mode);
}

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret", // pragma: allowlist secret
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret", // pragma: allowlist secret
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });

  it("does not infer aws-sdk for bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "unknown",
    );
  });

  it("does not infer aws-sdk for aws-bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("aws-bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "unknown",
    );
  });

  it("returns oauth for codex when Codex CLI auth is available", () => {
    const readCodexCliCredentialsCached = vi
      .spyOn(cliCredentials, "readCodexCliCredentialsCached")
      .mockReturnValue({
        type: "oauth",
        provider: "openai",
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      });

    try {
      expect(resolveModelAuthMode("codex", undefined, { version: 1, profiles: {} })).toBe("oauth");
      expect(readCodexCliCredentialsCached).toHaveBeenCalledWith({
        ttlMs: 5_000,
        allowKeychainPrompt: false,
      });
    } finally {
      readCodexCliCredentialsCached.mockRestore();
    }
  });
});

describe("requireApiKey", () => {
  it("formats missing auth errors with the checked credential source", () => {
    expect(
      formatMissingAuthError(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toBe(
      'No API key resolved for provider "openai" (auth mode: api-key, checked: env: OPENAI_API_KEY).',
    );
  });

  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "\n sk-test-abc\r\n",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow(
      'No API key resolved for provider "openai" (auth mode: api-key, checked: env: OPENAI_API_KEY).',
    );
  });

  it("throws typed missing auth errors with source metadata", () => {
    let thrown: unknown;
    try {
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      name: "MissingProviderAuthError",
      code: "missing-api-key",
      provider: "openai",
      mode: "api-key",
      source: "env: OPENAI_API_KEY",
    });
  });
});

describe("resolveUsableCustomProviderApiKey", () => {
  it("returns literal custom provider keys", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKey: "sk-custom-runtime", // pragma: allowlist secret
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });
    expect(resolved).toEqual({
      apiKey: "sk-custom-runtime",
      source: "models.json",
    });
  });

  it("does not treat non-env markers as usable credentials", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKey: NON_ENV_SECRETREF_MARKER,
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });
    expect(resolved).toBeNull();
  });

  it("does not treat the Vertex ADC marker as a usable models.json credential", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            "anthropic-vertex": {
              baseUrl: "https://us-central1-aiplatform.googleapis.com",
              apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
              models: [],
            },
          },
        },
      },
      provider: "anthropic-vertex",
    });
    expect(resolved).toBeNull();
  });

  it("resolves known env marker names from process env for custom providers", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: "OPENAI_API_KEY",
                models: [],
              },
            },
          },
        },
        provider: "custom",
        secretSentinels: true,
      });
      expect(resolved?.apiKey).toBe("sk-from-env");
      expect(resolved?.source).toContain("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves env SecretRefs from process env for custom providers", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-secretref-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_API_KEY",
                },
                models: [],
              },
            },
          },
        },
        provider: "custom",
        secretSentinels: true,
      });
      expect(looksLikeSecretSentinel(resolved?.apiKey ?? "")).toBe(true);
      expect(resolveSecretSentinel(resolved?.apiKey ?? "")).toBe("sk-secretref-env");
      expect(resolved?.source).toContain("OPENAI_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("sentinelizes config env SecretRefs on env-first provider resolution", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-secretref-env-first"; // pragma: allowlist secret
    try {
      const resolved = await resolveApiKeyForProvider({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "OPENAI_API_KEY",
                },
                models: [],
              },
            },
          },
        },
        provider: "custom",
        credentialPrecedence: "env-first",
        secretSentinels: true,
        store: { version: 1, profiles: {} },
      });

      expect(looksLikeSecretSentinel(resolved.apiKey ?? "")).toBe(true);
      expect(resolveSecretSentinel(resolved.apiKey ?? "")).toBe("sk-secretref-env-first");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves env SecretRefs with unknown env IDs from process env for custom providers", () => {
    const previous = process.env.MY_CUSTOM_KEY;
    process.env.MY_CUSTOM_KEY = "sk-custom-secretref-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MY_CUSTOM_KEY",
                },
                models: [],
              },
            },
          },
        },
        provider: "custom",
        secretSentinels: true,
      });
      expect(looksLikeSecretSentinel(resolved?.apiKey ?? "")).toBe(true);
      expect(resolveSecretSentinel(resolved?.apiKey ?? "")).toBe("sk-custom-secretref-env");
      expect(resolved?.source).toContain("MY_CUSTOM_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.MY_CUSTOM_KEY;
      } else {
        process.env.MY_CUSTOM_KEY = previous;
      }
    }
  });

  it("resolves legacy __env__ markers from process env for custom providers", () => {
    const previous = process.env.BAILIAN_API_KEY;
    process.env.BAILIAN_API_KEY = "sk-bailian-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          models: {
            providers: {
              bailian: {
                baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
                api: "openai-completions",
                apiKey: "__env__:BAILIAN_API_KEY", // pragma: allowlist secret
                models: [],
              },
            },
          },
        },
        provider: "bailian",
        secretSentinels: true,
      });
      expect(looksLikeSecretSentinel(resolved?.apiKey ?? "")).toBe(true);
      expect(resolveSecretSentinel(resolved?.apiKey ?? "")).toBe("sk-bailian-env");
      expect(resolved?.source).toContain("BAILIAN_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.BAILIAN_API_KEY;
      } else {
        process.env.BAILIAN_API_KEY = previous;
      }
    }
  });

  it("does not resolve env SecretRefs when provider allowlist excludes the env id", () => {
    const previous = process.env.MY_CUSTOM_KEY;
    process.env.MY_CUSTOM_KEY = "sk-custom-secretref-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          secrets: {
            providers: {
              "custom-env": {
                source: "env",
                allowlist: ["OPENAI_API_KEY"],
              },
            },
          },
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: {
                  source: "env",
                  provider: "custom-env",
                  id: "MY_CUSTOM_KEY",
                },
                models: [],
              },
            },
          },
        },
        provider: "custom",
      });
      expect(resolved).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.MY_CUSTOM_KEY;
      } else {
        process.env.MY_CUSTOM_KEY = previous;
      }
    }
  });

  it("does not resolve env SecretRefs when provider source is not env", () => {
    const previous = process.env.MY_CUSTOM_KEY;
    process.env.MY_CUSTOM_KEY = "sk-custom-secretref-env"; // pragma: allowlist secret
    try {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          secrets: {
            providers: {
              "custom-env": {
                source: "file",
                path: "/tmp/secrets.json",
              },
            },
          },
          models: {
            providers: {
              custom: {
                baseUrl: "https://example.com/v1",
                apiKey: {
                  source: "env",
                  provider: "custom-env",
                  id: "MY_CUSTOM_KEY",
                },
                models: [],
              },
            },
          },
        },
        provider: "custom",
      });
      expect(resolved).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.MY_CUSTOM_KEY;
      } else {
        process.env.MY_CUSTOM_KEY = previous;
      }
    }
  });

  it("does not treat env SecretRefs with missing unknown env IDs as usable", () => {
    const previous = process.env.MY_CUSTOM_KEY;
    delete process.env.MY_CUSTOM_KEY;
    try {
      expect(
        hasUsableCustomProviderApiKey(
          {
            models: {
              providers: {
                custom: {
                  baseUrl: "https://example.com/v1",
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "MY_CUSTOM_KEY",
                  },
                  models: [],
                },
              },
            },
          },
          "custom",
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.MY_CUSTOM_KEY;
      } else {
        process.env.MY_CUSTOM_KEY = previous;
      }
    }
  });

  it("does not treat non-env SecretRefs as usable models.json credentials", () => {
    const resolved = resolveUsableCustomProviderApiKey({
      cfg: {
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.com/v1",
              apiKey: {
                source: "file",
                provider: "vault",
                id: "custom-provider-key",
              },
              models: [],
            },
          },
        },
      },
      provider: "custom",
    });
    expect(resolved).toBeNull();
  });

  it("does not treat known env marker names as usable when env value is missing", () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(
        hasUsableCustomProviderApiKey(
          {
            models: {
              providers: {
                custom: {
                  baseUrl: "https://example.com/v1",
                  apiKey: "OPENAI_API_KEY",
                  models: [],
                },
              },
            },
          },
          "custom",
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });
});

describe("resolveApiKeyForProvider", () => {
  it("does not fall back to env or profiles after an explicit provider SecretRef fails", async () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "MISSING_OPENAI_KEY" } as const,
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(sourceConfig, sourceConfig);
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:MISSING_OPENAI_KEY"],
        reason: "secret reference was not found",
      },
    ]);

    await withEnv("OPENAI_API_KEY", "must-not-be-used", async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "openai",
          cfg: sourceConfig,
          store: {
            version: 1,
            profiles: {
              "openai:fallback": {
                type: "api_key",
                provider: "openai",
                key: "must-not-be-used-profile",
              },
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "provider",
        ownerId: "openai",
      } satisfies Partial<SecretSurfaceUnavailableError>);
    });
  });

  it("keeps the whole provider cold when a non-api-key SecretRef fails", async () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            headers: {
              "X-Provider-Secret": {
                source: "env",
                provider: "default",
                id: "MISSING_OPENAI_HEADER",
              } as const,
            },
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(sourceConfig, sourceConfig);
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.headers.X-Provider-Secret"],
        refKeys: ["env:default:MISSING_OPENAI_HEADER"],
        reason: "secret reference was not found",
      },
    ]);

    await withEnv("OPENAI_API_KEY", "must-not-be-used", async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "openai",
          cfg: sourceConfig,
          store: { version: 1, profiles: {} },
        }),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "provider",
        ownerId: "openai",
      } satisfies Partial<SecretSurfaceUnavailableError>);
    });
  });

  it("keeps a failed profile ref terminal without cooling an unrelated profile", async () => {
    const agentDir = "/tmp/openclaw-agent-profile-isolation";
    const coldProfileId = "openai:cold";
    const healthyProfileId = "anthropic:healthy";
    const store = {
      version: 1 as const,
      profiles: {
        [coldProfileId]: {
          type: "api_key" as const,
          provider: "openai",
          key: "stale-key-must-not-be-used",
          keyRef: { source: "env" as const, provider: "default", id: "MISSING_OPENAI_KEY" },
        },
        "openai:fallback": {
          type: "api_key" as const,
          provider: "openai",
          key: "fallback-profile-must-not-be-used",
        },
        [healthyProfileId]: {
          type: "api_key" as const,
          provider: "anthropic",
          key: "unused",
        },
      },
    };
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId,
        state: "unavailable",
        paths: [`${agentDir}.auth-profiles.${coldProfileId}.key`],
        refKeys: ["env:default:MISSING_OPENAI_KEY"],
        reason: "secret reference was not found",
      },
    ]);
    const cfg = {
      auth: {
        order: {
          openai: [coldProfileId, "openai:fallback"],
          anthropic: [healthyProfileId],
        },
      },
    };

    await expect(
      resolveApiKeyForProvider({
        provider: "anthropic",
        profileId: healthyProfileId,
        cfg,
        store,
        agentDir,
      }),
    ).resolves.toMatchObject({ apiKey: "unused", profileId: healthyProfileId });

    const request = vi.fn();
    await withEnv("OPENAI_API_KEY", "unused", async () => {
      await expect(
        (async () => {
          const auth = await resolveApiKeyForProvider({
            provider: "openai",
            cfg,
            store,
            agentDir,
          });
          await request(auth);
        })(),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "account",
        ownerId,
      } satisfies Partial<SecretSurfaceUnavailableError>);
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps plain environment credentials as plaintext", async () => {
    const resolved = await withEnv("OPENAI_API_KEY", "sk-plain-env-key", () =>
      resolveApiKeyForProvider({
        provider: "openai",
        store: { version: 1, profiles: {} },
      }),
    );

    expect(resolved.apiKey).toBe("sk-plain-env-key");
    expect(looksLikeSecretSentinel(resolved.apiKey ?? "")).toBe(false);
  });

  it("sentinelizes credentials resolved from auth-profile SecretRefs", async () => {
    const profileId = "openai:secretref";
    const agentDir = "/tmp/openclaw-agent-secretref-sentinel";
    const store = {
      version: 1 as const,
      profiles: {
        [profileId]: {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "env" as const, provider: "default", id: "OPENAI_PROFILE_SECRET" },
        },
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        ...store,
        profiles: {
          [profileId]: {
            ...store.profiles[profileId],
            key: "test-profile-api-key",
          },
        },
      },
      agentDir,
    );
    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      profileId,
      secretSentinels: true,
      store,
      agentDir,
    });

    expectSecretSentinelAuth(resolved, {
      value: "test-profile-api-key",
      source: `profile:${profileId}`,
      mode: "api-key",
    });
  });

  it("keeps SecretRef profile credentials request-ready outside model sentinel mode", async () => {
    const profileId = "openai:non-model";
    const agentDir = "/tmp/openclaw-agent-secretref-plain";
    const store = {
      version: 1 as const,
      profiles: {
        [profileId]: {
          type: "api_key" as const,
          provider: "openai",
          keyRef: { source: "env" as const, provider: "default", id: "OPENAI_NON_MODEL_SECRET" },
        },
      },
    };
    setRuntimeAuthProfileStoreSnapshot(
      {
        ...store,
        profiles: {
          [profileId]: {
            ...store.profiles[profileId],
            key: "test-non-model-api-key",
          },
        },
      },
      agentDir,
    );
    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      profileId,
      store,
      agentDir,
    });

    expect(resolved.apiKey).toBe("test-non-model-api-key");
    expect(looksLikeSecretSentinel(resolved.apiKey ?? "")).toBe(false);
  });

  it("reuses plugin fallback auth without a models.providers entry", async () => {
    const resolved = await withoutEnv("PLUGIN_WEB_API_KEY", () =>
      resolveApiKeyForProvider({
        provider: "plugin-web",
        cfg: {
          plugins: {
            entries: {
              "plugin-web": {
                config: {
                  webSearch: {
                    apiKey: "plugin-web-fallback-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      }),
    );

    expectAuthFields(resolved, {
      apiKey: "plugin-web-fallback-key",
      source: "plugins.entries.plugin-web.config.webSearch.apiKey",
      mode: "api-key",
    });
  });

  it("prefers the active runtime snapshot for SecretRef-backed plugin fallback auth", async () => {
    const sourceConfig = {
      plugins: {
        entries: {
          "plugin-web": {
            config: {
              webSearch: {
                apiKey: { source: "file", provider: "vault", id: "/plugin-web/api-key" },
              },
            },
          },
        },
      },
    };
    const runtimeConfig = {
      plugins: {
        entries: {
          "plugin-web": {
            config: {
              webSearch: {
                apiKey: "plugin-web-runtime-key", // pragma: allowlist secret
              },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const resolved = await withoutEnv("PLUGIN_WEB_API_KEY", () =>
      resolveApiKeyForProvider({
        provider: "plugin-web",
        cfg: sourceConfig,
        secretSentinels: true,
        store: { version: 1, profiles: {} },
      }),
    );

    expectSecretSentinelAuth(resolved, {
      value: "plugin-web-runtime-key",
      source: "plugins.entries.plugin-web.config.webSearch.apiKey",
      mode: "api-key",
    });
  });

  it.each([
    {
      name: "generated marker",
      apiKey: NON_ENV_SECRETREF_MARKER,
    },
    {
      name: "legacy env marker",
      apiKey: "secretref-env:CLIPROXY_API_KEY",
    },
    {
      name: "file SecretRef",
      apiKey: { source: "file", provider: "vault", id: "/cliproxy/api-key" } as const,
    },
  ])("resolves custom provider $name auth from the active runtime snapshot", async ({ apiKey }) => {
    const sourceConfig = {
      models: {
        providers: {
          cliproxyapi: {
            api: "openai-responses" as const,
            apiKey,
            baseUrl: "https://cliproxy.example/v1",
            models: [],
          },
        },
      },
    };
    const runtimeConfig = {
      models: {
        providers: {
          cliproxyapi: {
            ...sourceConfig.models.providers.cliproxyapi,
            apiKey: "sk-runtime-cliproxy", // pragma: allowlist secret
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const resolved = await resolveApiKeyForProvider({
      provider: "cliproxyapi",
      cfg: sourceConfig,
      secretSentinels: true,
      store: { version: 1, profiles: {} },
    });

    expectSecretSentinelAuth(resolved, {
      value: "sk-runtime-cliproxy",
      source: "models.providers.cliproxyapi",
      mode: "api-key",
    });
    await expect(
      hasAvailableAuthForProvider({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: { version: 1, profiles: {} },
      }),
    ).resolves.toBe(true);
    expect(
      hasRuntimeAvailableProviderAuth({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        allowPluginSyntheticAuth: false,
      }),
    ).toBe(true);
  });

  it("preserves SecretRef provenance for resolved runtime config clones", async () => {
    const sourceConfig = {
      models: {
        providers: {
          cliproxyapi: {
            api: "openai-responses" as const,
            apiKey: { source: "file", provider: "vault", id: "/cliproxy/api-key" } as const,
            baseUrl: "https://cliproxy.example/v1",
            models: [],
          },
        },
      },
    };
    const runtimeConfig = {
      models: {
        providers: {
          cliproxyapi: {
            ...sourceConfig.models.providers.cliproxyapi,
            apiKey: "sk-runtime-clone", // pragma: allowlist secret
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const resolved = await resolveApiKeyForProvider({
      provider: "cliproxyapi",
      cfg: structuredClone(runtimeConfig),
      secretSentinels: true,
      store: { version: 1, profiles: {} },
    });

    expectSecretSentinelAuth(resolved, {
      value: "sk-runtime-clone",
      source: "models.providers.cliproxyapi",
      mode: "api-key",
    });

    const preferred = await resolveApiKeyForProvider({
      provider: "cliproxyapi",
      cfg: structuredClone(runtimeConfig),
      preferredProfile: "cliproxyapi:preferred",
      credentialPrecedence: "profile-first",
      secretSentinels: true,
      store: {
        version: 1,
        profiles: {
          "cliproxyapi:preferred": {
            type: "api_key",
            provider: "cliproxyapi",
            key: "sk-preferred-profile", // pragma: allowlist secret
          },
        },
      },
    });
    expectAuthFields(preferred, {
      apiKey: "sk-preferred-profile",
      source: "profile:cliproxyapi:preferred",
      mode: "api-key",
    });
  });

  it("does not treat a custom provider managed SecretRef marker as auth without a runtime snapshot", async () => {
    const sourceConfig = {
      models: {
        providers: {
          cliproxyapi: {
            api: "openai-responses" as const,
            apiKey: NON_ENV_SECRETREF_MARKER,
            baseUrl: "https://cliproxy.example/v1",
            models: [],
          },
        },
      },
    };

    await expect(
      resolveApiKeyForProvider({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: { version: 1, profiles: {} },
      }),
    ).rejects.toThrow('No API key found for provider "cliproxyapi"');
    await expect(
      hasAvailableAuthForProvider({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: { version: 1, profiles: {} },
      }),
    ).resolves.toBe(false);
  });

  it("does not resolve custom provider managed SecretRef auth from an unrelated runtime snapshot", async () => {
    const sourceConfig = {
      models: {
        providers: {
          cliproxyapi: {
            api: "openai-responses" as const,
            apiKey: NON_ENV_SECRETREF_MARKER,
            baseUrl: "https://cliproxy.example/v1",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            cliproxyapi: {
              ...sourceConfig.models.providers.cliproxyapi,
              apiKey: "sk-runtime-wrong-source", // pragma: allowlist secret
            },
          },
        },
      },
      {
        models: {
          providers: {
            cliproxyapi: {
              ...sourceConfig.models.providers.cliproxyapi,
              baseUrl: "https://other.example/v1",
            },
          },
        },
      },
    );

    await expect(
      resolveApiKeyForProvider({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: { version: 1, profiles: {} },
      }),
    ).rejects.toThrow('No API key found for provider "cliproxyapi"');
  });

  it("does not reuse plugin fallback auth when the plugin is disabled", async () => {
    await expect(
      withoutEnv("PLUGIN_WEB_API_KEY", () =>
        resolveApiKeyForProvider({
          provider: "plugin-web",
          cfg: {
            plugins: {
              entries: {
                "plugin-web": {
                  enabled: false,
                  config: {
                    webSearch: {
                      apiKey: "plugin-web-fallback-key", // pragma: allowlist secret
                    },
                  },
                },
              },
            },
          },
          store: { version: 1, profiles: {} },
        }),
      ),
    ).rejects.toThrow('No API key found for provider "plugin-web"');
  });

  it("reuses plugin-owned native CLI auth", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "native-cli",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "native-cli/demo-model",
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expect(resolved).toEqual({
      apiKey: "native-cli-access-token",
      source: "Native CLI auth",
      mode: "oauth",
    });
  });

  it("reuses the loaded auth profile store after deferring an explicit synthetic profile", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "custom-auth",
      profileId: "custom-auth:synthetic",
      store: {
        version: 1,
        profiles: {
          "custom-auth:synthetic": {
            type: "api_key",
            provider: "custom-auth",
            key: "synthetic-defer", // pragma: allowlist secret
          },
          "custom-auth:real": {
            type: "api_key",
            provider: "custom-auth",
            key: "sk-real", // pragma: allowlist secret
          },
        },
      },
    });

    expectAuthFields(auth, {
      apiKey: "sk-real",
      source: "profile:custom-auth:real",
      mode: "api-key",
    });
  });

  it("prefers explicit api-key provider config over ambient auth profiles", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              auth: "api-key",
              apiKey: "sk-config-live", // pragma: allowlist secret
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      store: {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-profile-stale", // pragma: allowlist secret
          },
        },
      },
    });

    expectAuthFields(resolved, {
      apiKey: "sk-config-live",
      source: "models.json",
      mode: "api-key",
    });
  });

  it("preserves explicit subscription modes for literal provider credentials", async () => {
    for (const mode of ["oauth", "token"] as const) {
      const provider = `custom-${mode}`;
      const resolved = await getApiKeyForModel({
        model: {
          id: "subscription-model",
          provider,
          api: "openai-completions",
        } as Model,
        cfg: {
          models: {
            providers: {
              [provider]: {
                auth: mode,
                apiKey: "configured-subscription-credential",
                baseUrl: "https://subscription.example/v1",
                models: [],
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      });

      expect(resolved).toMatchObject({
        apiKey: "configured-subscription-credential",
        source: "models.json",
        mode,
      });
    }
  });

  it("does not reinterpret explicit OpenAI oauth material as a Platform API key", async () => {
    await expect(
      getApiKeyForModel({
        model: {
          id: "platform-model",
          provider: "openai",
          api: "openai-responses",
        } as Model,
        cfg: {
          models: {
            providers: {
              openai: {
                auth: "oauth",
                apiKey: "configured-subscription-credential",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      }),
    ).rejects.toThrow('No API key found for provider "openai"');
  });

  it("preserves token mode for an env-backed provider SecretRef", async () => {
    await withEnv(
      "OPENCLAW_TEST_PROVIDER_SUBSCRIPTION_TOKEN",
      "env-subscription-credential",
      async () => {
        const resolved = await getApiKeyForModel({
          model: {
            id: "subscription-model",
            provider: "custom-token-env",
            api: "openai-completions",
          } as Model,
          cfg: {
            models: {
              providers: {
                "custom-token-env": {
                  auth: "token",
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "OPENCLAW_TEST_PROVIDER_SUBSCRIPTION_TOKEN",
                  },
                  baseUrl: "https://subscription.example/v1",
                  models: [],
                },
              },
            },
          },
          store: { version: 1, profiles: {} },
        });

        expect(resolved).toMatchObject({
          apiKey: "env-subscription-credential",
          mode: "token",
        });
        expect(resolved.source).toContain("OPENCLAW_TEST_PROVIDER_SUBSCRIPTION_TOKEN");
      },
    );
  });

  it("prefers explicit api-key provider SecretRef config over ambient auth profiles", async () => {
    const sourceConfig = {
      models: {
        providers: {
          cliproxyapi: {
            api: "openai-responses" as const,
            auth: "api-key" as const,
            apiKey: { source: "file", provider: "vault", id: "/cliproxy/api-key" } as const,
            baseUrl: "https://cliproxy.example/v1",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            cliproxyapi: {
              ...sourceConfig.models.providers.cliproxyapi,
              apiKey: "sk-runtime-cliproxy", // pragma: allowlist secret
            },
          },
        },
      },
      sourceConfig,
    );

    const resolved = await resolveApiKeyForProvider({
      provider: "cliproxyapi",
      cfg: sourceConfig,
      secretSentinels: true,
      store: {
        version: 1,
        profiles: {
          "cliproxyapi:default": {
            type: "api_key",
            provider: "cliproxyapi",
            key: "sk-profile-stale", // pragma: allowlist secret
          },
        },
      },
    });

    expectSecretSentinelAuth(resolved, {
      value: "sk-runtime-cliproxy",
      source: "models.providers.cliproxyapi",
      mode: "api-key",
    });
  });

  it("preserves oauth mode for a managed provider SecretRef", async () => {
    const sourceConfig = {
      models: {
        providers: {
          "custom-oauth-ref": {
            api: "openai-completions" as const,
            auth: "oauth" as const,
            apiKey: { source: "file", provider: "vault", id: "/custom/oauth" } as const,
            baseUrl: "https://subscription.example/v1",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            "custom-oauth-ref": {
              ...sourceConfig.models.providers["custom-oauth-ref"],
              apiKey: "resolved-oauth-credential",
            },
          },
        },
      },
      sourceConfig,
    );

    const resolved = await getApiKeyForModel({
      model: {
        id: "subscription-model",
        provider: "custom-oauth-ref",
        api: "openai-completions",
      } as Model,
      cfg: sourceConfig,
      store: { version: 1, profiles: {} },
      secretSentinels: true,
    });

    expectSecretSentinelAuth(resolved, {
      value: "resolved-oauth-credential",
      source: "models.providers.custom-oauth-ref",
      mode: "oauth",
    });
  });

  it("prefers non-secret local env markers over ambient profiles", async () => {
    const resolved = await withEnv("OLLAMA_API_KEY", "ollama-local", () =>
      resolveApiKeyForProvider({
        provider: "ollama",
        store: {
          version: 1,
          profiles: {
            "ollama:default": {
              type: "api_key",
              provider: "ollama",
              key: "ollama-cloud-profile", // pragma: allowlist secret
            },
          },
        },
      }),
    );

    expectAuthFields(resolved, {
      apiKey: "ollama-local",
      mode: "api-key",
    });
    expect(resolved.source).toContain("OLLAMA_API_KEY");
  });
});

describe("resolveApiKeyForProvider – synthetic local auth for custom providers", () => {
  it("recognizes local baseUrl variants for synthetic auth config", () => {
    const localBaseUrls = [
      "http://127.0.0.1:8080/v1",
      "http://192.168.0.222:11434/v1",
      "http://localhost:11434/v1",
      "http://[::1]:8080/v1",
      "http://0.0.0.0:11434/v1",
      "http://[::ffff:127.0.0.1]:8080/v1",
    ];

    for (const baseUrl of localBaseUrls) {
      expect(
        hasSyntheticLocalProviderAuthConfig({
          provider: "custom-local",
          cfg: {
            models: {
              providers: {
                "custom-local": createCustomProviderConfig(baseUrl),
              },
            },
          },
        }),
        baseUrl,
      ).toBe(true);
    }
  });

  it("synthesizes a local auth marker for custom providers with a local baseUrl and no apiKey", async () => {
    const auth = await resolveCustomProviderAuth(
      "custom-127-0-0-1-8080",
      "http://127.0.0.1:8080/v1",
      "qwen-3.5",
      "Qwen 3.5",
    );
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(auth.source).toContain("synthetic local key");
  });

  it("does not synthesize auth for remote custom providers without apiKey", async () => {
    expect(
      hasSyntheticLocalProviderAuthConfig({
        provider: "my-remote",
        cfg: {
          models: {
            providers: {
              "my-remote": createCustomProviderConfig("https://api.example.com/v1"),
            },
          },
        },
      }),
    ).toBe(false);

    await expect(
      resolveApiKeyForProvider({
        provider: "my-remote",
        cfg: {
          models: {
            providers: {
              "my-remote": {
                baseUrl: "https://api.example.com/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "gpt-5",
                    name: "GPT-5",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
      }),
    ).rejects.toThrow("No API key found");
  });

  it("preserves custom named Ollama providers with explicit local marker auth", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "ollama-remote",
      cfg: {
        models: {
          providers: {
            "ollama-remote": {
              baseUrl: "http://192.168.178.122:11434",
              api: "ollama",
              apiKey: "ollama-local",
              models: [
                {
                  id: "qwen3.5:27b",
                  name: "Qwen 3.5 27B",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expectAuthFields(auth, {
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });
  });

  it("uses Ollama plugin synthetic auth for custom private provider ids without apiKey", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "ollama-gpu1",
      cfg: {
        models: {
          providers: {
            "ollama-gpu1": {
              baseUrl: "http://192.168.178.122:11435",
              api: "ollama",
              models: [
                {
                  id: "qwen3:14b",
                  name: "Qwen 3 14B",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 16384,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expectAuthFields(auth, {
      apiKey: "ollama-local",
      source: "models.providers.ollama-gpu1 (synthetic local key)",
      mode: "api-key",
    });
  });

  it("prefers a custom Ollama provider SecretRef runtime key over plugin synthetic auth", async () => {
    const providerConfig = {
      ...createCustomProviderConfig("http://192.168.178.122:11435", "qwen3:14b", "Qwen 3 14B"),
      api: "ollama" as const,
      apiKey: { source: "file", provider: "vault", id: "/ollama/api-key" } as const,
    };
    const sourceConfig = {
      models: {
        providers: {
          "ollama-gpu1": providerConfig,
        },
      },
    };
    setRuntimeConfigSnapshot(
      {
        models: {
          providers: {
            "ollama-gpu1": {
              ...providerConfig,
              apiKey: "sk-runtime-ollama", // pragma: allowlist secret
            },
          },
        },
      },
      sourceConfig,
    );

    const auth = await resolveApiKeyForProvider({
      provider: "ollama-gpu1",
      cfg: sourceConfig,
      secretSentinels: true,
      store: { version: 1, profiles: {} },
    });

    expectSecretSentinelAuth(auth, {
      value: "sk-runtime-ollama",
      source: "models.providers.ollama-gpu1",
      mode: "api-key",
    });
  });

  it("resolves synthetic auth when model overrides api to ollama within a non-ollama provider", async () => {
    const auth = await getApiKeyForModel({
      model: {
        id: "my-router/local-llama",
        name: "Local Llama",
        provider: "my-router",
        api: "ollama",
        baseUrl: "http://localhost:11434",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
      cfg: {
        models: {
          providers: {
            "my-router": {
              baseUrl: "http://localhost:8080/v1",
              api: "openai-completions",
              models: [
                {
                  id: "my-router/local-llama",
                  name: "Local Llama",
                  api: "ollama",
                  baseUrl: "http://localhost:11434",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expectAuthFields(auth, {
      apiKey: "ollama-local",
      source: "models.providers.my-router (synthetic local key)",
      mode: "api-key",
    });
  });

  it("accepts non-secret local markers for private LAN custom OpenAI-compatible providers", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "custom-192-168-0-222-11434",
      cfg: {
        models: {
          providers: {
            "custom-192-168-0-222-11434": {
              baseUrl: "http://192.168.0.222:11434/v1",
              api: "openai-completions",
              apiKey: "ollama-local",
              models: [
                {
                  id: "qwen3.5:9b",
                  name: "Qwen 3.5 9B",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expectAuthFields(auth, {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.json (local marker)",
      mode: "api-key",
    });
  });

  it.each(["docker.orb.internal", "host.docker.internal", "host.orb.internal"])(
    "accepts ollama-local marker auth for host-backed alias %s",
    async (hostname) => {
      const auth = await resolveApiKeyForProvider({
        provider: "ollama",
        cfg: {
          models: {
            providers: {
              ollama: {
                baseUrl: `http://${hostname}:11434`,
                api: "ollama",
                apiKey: "ollama-local",
                models: [
                  {
                    id: "qwen3.5:27b",
                    name: "Qwen 3.5 27B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 262144,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      });

      expectAuthFields(auth, {
        apiKey: "ollama-local",
        source: "models.json (local marker)",
        mode: "api-key",
      });
    },
  );

  it("does not accept non-secret local markers for remote custom providers", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "custom-remote",
        cfg: {
          models: {
            providers: {
              "custom-remote": {
                baseUrl: "https://api.example.com/v1",
                api: "openai-completions",
                apiKey: "ollama-local",
                models: [
                  {
                    id: "qwen3.5:9b",
                    name: "Qwen 3.5 9B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      }),
    ).rejects.toThrow('No API key found for provider "custom-remote"');
  });

  it("does not synthesize local auth when apiKey is explicitly configured but unresolved", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        resolveApiKeyForProvider({
          provider: "custom",
          cfg: {
            models: {
              providers: {
                custom: {
                  baseUrl: "http://127.0.0.1:8080/v1",
                  api: "openai-completions",
                  apiKey: "OPENAI_API_KEY",
                  models: [
                    {
                      id: "llama3",
                      name: "Llama 3",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 8192,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
          },
        }),
      ).rejects.toThrow('No API key found for provider "custom"');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("does not synthesize local auth when auth mode explicitly requires oauth", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "custom",
        cfg: {
          models: {
            providers: {
              custom: {
                baseUrl: "http://127.0.0.1:8080/v1",
                api: "openai-completions",
                auth: "oauth",
                models: [
                  {
                    id: "llama3",
                    name: "Llama 3",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
      }),
    ).rejects.toThrow('No API key found for provider "custom"');
  });

  it("uses explicit aws-sdk auth for local baseUrl overrides", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "amazon-bedrock",
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
              auth: "aws-sdk",
            },
          },
        },
      },
    });

    expect(auth.mode).toBe("aws-sdk");
    expect(auth.apiKey).toBeUndefined();
  });

  it("uses implicit aws-sdk auth for built-in Bedrock Converse models", async () => {
    const auth = await getApiKeyForModel({
      model: {
        id: "us.anthropic.claude-sonnet-4-6-v1",
        name: "Claude Sonnet",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      store: { version: 1, profiles: {} },
    });

    expect(auth.mode).toBe("aws-sdk");
    expect(auth.apiKey).toBeUndefined();
  });
});

describe("applyLocalNoAuthHeaderOverride", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks synthetic local OpenAI-compatible auth so SDK request headers clear Authorization", () => {
    const model = applyLocalNoAuthHeaderOverride(
      {
        id: "local-llm",
        name: "local-llm",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
        headers: { "X-Test": "1" },
      } as Model<"openai-completions">,
      {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.custom (synthetic local key)",
        mode: "api-key",
      },
    );

    expect(model.headers?.Authorization).toBeNull();
    expect(model.headers?.["X-Test"]).toBe("1");
  });
});

describe("applyAuthHeaderOverride", () => {
  const baseModel: Model<"openai-completions"> = {
    id: "gemini-3.1-flash-lite",
    name: "gemini-3.1-flash-lite",
    api: "openai-completions" as const,
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };

  it("injects Authorization Bearer header when authHeader is true", () => {
    const result = applyAuthHeaderOverride(
      baseModel,
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              authHeader: true,
              models: [],
            },
          },
        },
      },
    );

    expect(result.headers).toEqual({ Authorization: "Bearer test-api-key" });
  });

  it("preserves existing model headers when injecting Authorization", () => {
    const result = applyAuthHeaderOverride(
      { ...baseModel, headers: { "X-Custom": "value" } },
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              authHeader: true,
              models: [],
            },
          },
        },
      },
    );

    expect(result.headers).toEqual({
      "X-Custom": "value",
      Authorization: "Bearer test-api-key",
    });
  });

  it("sentinelizes SecretRef-managed provider headers from the runtime snapshot", () => {
    const sourceConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions" as const,
            headers: {
              Authorization: "secretref-env:GOOGLE_AUTH_TOKEN",
              "X-Managed": NON_ENV_SECRETREF_MARKER,
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig = {
      models: {
        providers: {
          google: {
            ...sourceConfig.models.providers.google,
            headers: {
              Authorization: "Bearer runtime-google-secret",
              "X-Managed": "runtime-managed-secret",
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applyAuthHeaderOverride(
      {
        ...baseModel,
        headers: {
          Authorization: "Bearer runtime-google-secret",
          "X-Managed": "runtime-managed-secret",
          "X-Plain": "visible",
        },
      },
      null,
      sourceConfig,
    );

    expect(looksLikeSecretSentinel(result.headers?.Authorization ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.headers?.Authorization ?? "")).toBe(
      "Bearer runtime-google-secret",
    );
    expect(looksLikeSecretSentinel(result.headers?.["X-Managed"] ?? "")).toBe(true);
    expect(resolveSecretSentinel(result.headers?.["X-Managed"] ?? "")).toBe(
      "runtime-managed-secret",
    );
    expect(result.headers?.["X-Plain"]).toBe("visible");
  });

  it("sentinelizes SecretRef-managed request headers and composed auth", () => {
    const sourceConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions" as const,
            request: {
              headers: { "X-Managed": NON_ENV_SECRETREF_MARKER },
              auth: {
                mode: "authorization-bearer" as const,
                token: "secretref-env:GOOGLE_BEARER_TOKEN",
              },
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig = {
      models: {
        providers: {
          google: {
            ...sourceConfig.models.providers.google,
            request: {
              headers: { "X-Managed": "runtime-managed-secret" },
              auth: {
                mode: "authorization-bearer" as const,
                token: "runtime-bearer-secret",
              },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applySecretRefHeaderSentinels(
      attachModelProviderRequestTransport(
        {
          ...baseModel,
          headers: {
            "X-Managed": "runtime-managed-secret",
            Authorization: "Bearer runtime-bearer-secret",
          },
        },
        runtimeConfig.models.providers.google.request,
      ),
      sourceConfig,
    );

    const managedSentinel = result.headers?.["X-Managed"] ?? "";
    expect(looksLikeSecretSentinel(managedSentinel)).toBe(true);
    expect(resolveSecretSentinel(managedSentinel)).toBe("runtime-managed-secret");
    const bearerSentinel = result.headers?.Authorization?.slice("Bearer ".length) ?? "";
    expect(looksLikeSecretSentinel(bearerSentinel)).toBe(true);
    expect(resolveSecretSentinel(bearerSentinel)).toBe("runtime-bearer-secret");
    const request = getModelProviderRequestTransport(result);
    const requestHeaderSentinel = request?.headers?.["X-Managed"] ?? "";
    expect(looksLikeSecretSentinel(requestHeaderSentinel)).toBe(true);
    expect(resolveSecretSentinel(requestHeaderSentinel)).toBe("runtime-managed-secret");
    expect(request?.auth?.mode).toBe("authorization-bearer");
    const requestTokenSentinel =
      request?.auth?.mode === "authorization-bearer" ? request.auth.token : "";
    expect(looksLikeSecretSentinel(requestTokenSentinel)).toBe(true);
    expect(resolveSecretSentinel(requestTokenSentinel)).toBe("runtime-bearer-secret");
  });

  it("returns model unchanged when authHeader is not set", () => {
    const result = applyAuthHeaderOverride(
      baseModel,
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
    );

    expect(result).toBe(baseModel);
  });

  it("returns model unchanged when authHeader is false", () => {
    const result = applyAuthHeaderOverride(
      baseModel,
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              authHeader: false,
              models: [],
            },
          },
        },
      },
    );

    expect(result).toBe(baseModel);
  });

  it("returns model unchanged when no API key is available", () => {
    const result = applyAuthHeaderOverride(baseModel, null, {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            api: "openai-completions",
            authHeader: true,
            models: [],
          },
        },
      },
    });

    expect(result).toBe(baseModel);
  });

  it("returns model unchanged when provider config is missing", () => {
    const result = applyAuthHeaderOverride(
      baseModel,
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      undefined,
    );

    expect(result).toBe(baseModel);
  });

  it("rejects synthetic marker API keys", () => {
    const result = applyAuthHeaderOverride(
      baseModel,
      { apiKey: CUSTOM_LOCAL_AUTH_MARKER, source: "synthetic", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              authHeader: true,
              models: [],
            },
          },
        },
      },
    );

    expect(result).toBe(baseModel);
  });

  it("strips existing authorization header case-insensitively before injection", () => {
    const result = applyAuthHeaderOverride(
      { ...baseModel, headers: { authorization: "old-value", "X-Custom": "keep" } },
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              api: "openai-completions",
              authHeader: true,
              models: [],
            },
          },
        },
      },
    );

    expect(result.headers).toEqual({
      "X-Custom": "keep",
      Authorization: "Bearer test-api-key",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
