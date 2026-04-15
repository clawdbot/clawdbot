import { streamSimpleOpenAICompletions, type Model } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/config.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  GCP_VERTEX_CREDENTIALS_MARKER,
  NON_ENV_SECRETREF_MARKER,
} from "./model-auth-markers.js";

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    buildProviderMissingAuthMessageWithPlugin: () => undefined,
    resolveExternalAuthProfilesWithPlugins: () => [],
    shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
      provider: string;
      context: { resolvedApiKey?: string };
    }) => params.provider === "ollama" && params.context.resolvedApiKey?.trim() === "ollama-local",
    resolveProviderSyntheticAuthWithPlugin: (params: {
      provider: string;
      config?: {
        plugins?: {
          enabled?: boolean;
          entries?: {
            xai?: {
              enabled?: boolean;
              config?: {
                webSearch?: {
                  apiKey?: unknown;
                };
              };
            };
          };
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
      context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
    }) => {
      if (params.provider === "xai") {
        if (
          params.config?.plugins?.enabled === false ||
          params.config?.plugins?.entries?.xai?.enabled === false
        ) {
          return undefined;
        }
        const pluginApiKey = params.config?.plugins?.entries?.xai?.config?.webSearch?.apiKey;
        if (typeof pluginApiKey === "string" && pluginApiKey.trim()) {
          return {
            apiKey: pluginApiKey.trim(),
            source: "plugins.entries.xai.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        if (pluginApiKey && typeof pluginApiKey === "object") {
          return {
            apiKey: NON_ENV_SECRETREF_MARKER,
            source: "plugins.entries.xai.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        return undefined;
      }
      if (params.provider === "claude-cli") {
        return {
          apiKey: "claude-cli-access-token",
          source: "Claude CLI native auth",
          mode: "oauth" as const,
        };
      }
      if (params.provider !== "ollama") {
        return undefined;
      }
      const providerConfig = params.context.providerConfig;
      const hasMeaningfulOllamaConfig =
        (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0) ||
        Boolean(providerConfig?.api?.trim() && providerConfig.api.trim() !== "ollama") ||
        Boolean(
          providerConfig?.baseUrl?.trim() &&
          providerConfig.baseUrl.trim().replace(/\/+$/, "") !== "http://127.0.0.1:11434",
        );
      if (!hasMeaningfulOllamaConfig) {
        return undefined;
      }
      return {
        apiKey: "ollama-local",
        source: "models.providers.ollama (synthetic local key)",
        mode: "api-key" as const,
      };
    },
  };
});

let applyAuthHeaderOverride: typeof import("./model-auth.js").applyAuthHeaderOverride;
let applyLocalNoAuthHeaderOverride: typeof import("./model-auth.js").applyLocalNoAuthHeaderOverride;
let hasUsableCustomProviderApiKey: typeof import("./model-auth.js").hasUsableCustomProviderApiKey;
let requireApiKey: typeof import("./model-auth.js").requireApiKey;
let resolveApiKeyForProvider: typeof import("./model-auth.js").resolveApiKeyForProvider;
let resolveAwsSdkEnvVarName: typeof import("./model-auth.js").resolveAwsSdkEnvVarName;
let resolveModelAuthMode: typeof import("./model-auth.js").resolveModelAuthMode;
let resolveUsableCustomProviderApiKey: typeof import("./model-auth.js").resolveUsableCustomProviderApiKey;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;

beforeAll(async () => {
  vi.resetModules();
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } = await import("../config/config.js"));
  ({
    applyAuthHeaderOverride,
    applyLocalNoAuthHeaderOverride,
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
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

async function withoutEnv<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  delete process.env[key];
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

function createCustomProviderConfig(
  baseUrl: string,
  modelId = "llama3",
  modelName = "Llama 3",
): ModelProviderConfig {
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

  it("returns aws-sdk for bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });

  it("returns aws-sdk for aws-bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("aws-bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });
});

describe("requireApiKey", () => {
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
    ).toThrow('No API key resolved for provider "openai"');
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
      });
      expect(resolved?.apiKey).toBe("sk-secretref-env");
      expect(resolved?.source).toContain("OPENAI_API_KEY");
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
      });
      expect(resolved?.apiKey).toBe("sk-custom-secretref-env");
      expect(resolved?.source).toContain("MY_CUSTOM_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.MY_CUSTOM_KEY;
      } else {
        process.env.MY_CUSTOM_KEY = previous;
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
  it("reuses the xai plugin web search key without models.providers.xai", async () => {
    const resolved = await withoutEnv("XAI_API_KEY", () =>
      resolveApiKeyForProvider({
        provider: "xai",
        cfg: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "xai-plugin-fallback-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
      }),
    );

    expect(resolved).toMatchObject({
      apiKey: "xai-plugin-fallback-key",
      source: "plugins.entries.xai.config.webSearch.apiKey",
      mode: "api-key",
    });
  });

  it("prefers the active runtime snapshot for SecretRef-backed xai fallback auth", async () => {
    const sourceConfig = {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: { source: "file", provider: "vault", id: "/xai/api-key" },
              },
            },
          },
        },
      },
    };
    const runtimeConfig = {
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: "xai-runtime-key", // pragma: allowlist secret
              },
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const resolved = await withoutEnv("XAI_API_KEY", () =>
      resolveApiKeyForProvider({
        provider: "xai",
        cfg: sourceConfig,
        store: { version: 1, profiles: {} },
      }),
    );

    expect(resolved).toMatchObject({
      apiKey: "xai-runtime-key",
      source: "plugins.entries.xai.config.webSearch.apiKey",
      mode: "api-key",
    });
  });

  it("does not reuse xai fallback auth when the xai plugin is disabled", async () => {
    await expect(
      withoutEnv("XAI_API_KEY", () =>
        resolveApiKeyForProvider({
          provider: "xai",
          cfg: {
            plugins: {
              entries: {
                xai: {
                  enabled: false,
                  config: {
                    webSearch: {
                      apiKey: "xai-plugin-fallback-key", // pragma: allowlist secret
                    },
                  },
                },
              },
            },
          },
          store: { version: 1, profiles: {} },
        }),
      ),
    ).rejects.toThrow('No API key found for provider "xai"');
  });

  it("reuses native Claude CLI auth for the claude-cli provider", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "claude-cli",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "claude-cli/claude-sonnet-4-6",
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
    });

    expect(resolved).toEqual({
      apiKey: "claude-cli-access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
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

    expect(resolved).toMatchObject({
      apiKey: "sk-config-live",
      source: "models.json",
      mode: "api-key",
    });
  });
});

describe("resolveApiKeyForProvider – synthetic local auth for custom providers", () => {
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

  it("synthesizes a local auth marker for localhost custom providers", async () => {
    const auth = await resolveCustomProviderAuth("my-local", "http://localhost:11434/v1");
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for IPv6 loopback (::1)", async () => {
    const auth = await resolveCustomProviderAuth("my-ipv6", "http://[::1]:8080/v1");
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for 0.0.0.0", async () => {
    const auth = await resolveCustomProviderAuth(
      "my-wildcard",
      "http://0.0.0.0:11434/v1",
      "qwen",
      "Qwen",
    );
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("synthesizes a local auth marker for IPv4-mapped IPv6 (::ffff:127.0.0.1)", async () => {
    const auth = await resolveCustomProviderAuth("my-mapped", "http://[::ffff:127.0.0.1]:8080/v1");
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("does not synthesize auth for remote custom providers without apiKey", async () => {
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

  it("keeps built-in aws-sdk fallback for local baseUrl overrides", async () => {
    const auth = await resolveApiKeyForProvider({
      provider: "amazon-bedrock",
      cfg: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(auth.mode).toBe("aws-sdk");
    expect(auth.apiKey).toBeUndefined();
  });
});

describe("applyLocalNoAuthHeaderOverride", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("clears Authorization for synthetic local OpenAI-compatible auth markers", async () => {
    let capturedAuthorization: string | null | undefined;
    let capturedXTest: string | null | undefined;
    let resolveRequest: (() => void) | undefined;
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    globalThis.fetch = withFetchPreconnect(
      vi.fn(async (_input, init) => {
        const headers = new Headers(init?.headers);
        capturedAuthorization = headers.get("Authorization");
        capturedXTest = headers.get("X-Test");
        resolveRequest?.();
        return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }),
    );

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

    streamSimpleOpenAICompletions(
      model,
      {
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      },
    );

    await requestSeen;

    expect(capturedAuthorization).toBeNull();
    expect(capturedXTest).toBe("1");
  });
});

describe("applyAuthHeaderOverride", () => {
  const baseModel: Model<"openai-completions"> = {
    id: "gemini-3.1-flash-lite-preview",
    name: "gemini-3.1-flash-lite-preview",
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
