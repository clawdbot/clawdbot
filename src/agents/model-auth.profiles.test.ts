import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
} from "./auth-profiles/store.js";
import type { OAuthCredential } from "./auth-profiles/types.js";
import type { ClaudeCliCredential } from "./cli-credentials.js";
import {
  getApiKeyForModel,
  hasAvailableAuthForProvider,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
  resolveModelAuthMode,
} from "./model-auth.js";
import { hasAuthForModelProvider } from "./model-provider-auth.js";

async function expectVertexAdcEnvApiKey(params: {
  provider: string;
  credentialsJson: string;
  env?: NodeJS.ProcessEnv;
  tempPrefix?: string;
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), params.tempPrefix ?? "openclaw-adc-"));
  const credentialsPath = path.join(tempDir, "adc.json");
  await fs.writeFile(credentialsPath, params.credentialsJson, "utf8");

  try {
    const resolved = resolveEnvApiKey(params.provider, {
      ...params.env,
      GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
    } as NodeJS.ProcessEnv);

    expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
    expect(resolved?.source).toBe("gcloud adc");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function testModelDefinition(id: string): Model<Api> {
  return {
    id,
    name: id,
    provider: "test",
    api: "responses",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

vi.mock("../plugins/setup-registry.js", async () => {
  const { readFileSync } = await import("node:fs");
  return {
    resolvePluginSetupProvider: ({ provider }: { provider: string; env: NodeJS.ProcessEnv }) => {
      if (provider !== "anthropic-vertex") {
        return undefined;
      }
      return {
        resolveConfigApiKey: ({ env }: { env: NodeJS.ProcessEnv }) => {
          const metadataOptIn = env.ANTHROPIC_VERTEX_USE_GCP_METADATA?.trim().toLowerCase();
          if (metadataOptIn === "1" || metadataOptIn === "true") {
            return "gcp-vertex-credentials";
          }
          const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
          if (!credentialsPath) {
            return undefined;
          }
          try {
            readFileSync(credentialsPath, "utf8");
            return "gcp-vertex-credentials";
          } catch {
            return undefined;
          }
        },
      };
    },
  };
});

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    if (normalized === "modelstudio" || normalized === "qwencloud") {
      return "qwen";
    }
    if (normalized === "z.ai" || normalized === "z-ai") {
      return "zai";
    }
    if (normalized === "opencode-go-auth") {
      return "opencode-go";
    }
    if (normalized === "bedrock" || normalized === "aws-bedrock") {
      return "amazon-bedrock";
    }
    return normalized;
  },
}));

vi.mock("./model-auth-env-vars.js", () => {
  const hasAllowedPlugin = (config: unknown, pluginId: string): boolean => {
    if (!config || typeof config !== "object") {
      return false;
    }
    const plugins = (config as { plugins?: unknown }).plugins;
    if (!plugins || typeof plugins !== "object") {
      return false;
    }
    const allow = (plugins as { allow?: unknown }).allow;
    return Array.isArray(allow) && allow.includes(pluginId);
  };
  const candidates = {
    anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
    "demo-local": ["DEMO_LOCAL_API_KEY"],
    huggingface: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
    "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    qianfan: ["QIANFAN_API_KEY"],
    qwen: ["QWEN_API_KEY", "MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY"],
    synthetic: ["SYNTHETIC_API_KEY"],
    "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
    voyage: ["VOYAGE_API_KEY"],
    zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  } as const;
  return {
    PROVIDER_ENV_API_KEY_CANDIDATES: candidates,
    listKnownProviderEnvApiKeyNames: () => [...new Set(Object.values(candidates).flat())],
    resolveProviderEnvApiKeyCandidates: () => candidates,
    resolveProviderEnvAuthEvidence: (params?: { config?: OpenClawConfig }) => {
      const evidence = {
        "google-vertex": [
          {
            type: "local-file-with-env",
            fileEnvVar: "GOOGLE_APPLICATION_CREDENTIALS",
            fallbackPaths: [
              "${HOME}/.config/gcloud/application_default_credentials.json",
              "${APPDATA}/gcloud/application_default_credentials.json",
            ],
            requiresAnyEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
            requiresAllEnv: ["GOOGLE_CLOUD_LOCATION"],
            credentialMarker: "gcp-vertex-credentials",
            source: "gcloud adc",
          },
        ],
      } satisfies Record<string, readonly unknown[]>;
      if (!hasAllowedPlugin(params?.config, "workspace-cloud")) {
        return evidence;
      }
      return {
        ...evidence,
        "workspace-cloud": [
          {
            type: "local-file-with-env",
            fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
            credentialMarker: "workspace-cloud-local-credentials",
            source: "workspace cloud credentials",
          },
        ],
      };
    },
  };
});

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: (params: {
    provider: string;
    context: { listProfileIds: (providerId: string) => string[] };
  }) => {
    if (params.provider === "openai" && params.context.listProfileIds("openai-codex").length > 0) {
      return 'No API key found for provider "openai". Use openai/gpt-5.5.';
    }
    return undefined;
  },
  formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
  resolveProviderSyntheticAuthWithPlugin: (params: {
    provider: string;
    context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
  }) => {
    if (params.provider !== "demo-local") {
      return undefined;
    }
    const providerConfig = params.context.providerConfig;
    const hasMeaningfulConfig =
      Boolean(providerConfig?.api?.trim()) ||
      Boolean(providerConfig?.baseUrl?.trim()) ||
      (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0);
    if (!hasMeaningfulConfig) {
      return undefined;
    }
    return {
      apiKey: "demo-local",
      source: `models.providers.${params.provider} (synthetic local key)`,
      mode: "api-key" as const,
    };
  },
  resolveExternalAuthProfilesWithPlugins: () => [],
  shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
    provider: string;
    context: { resolvedApiKey?: string };
  }) => {
    const expectedMarker = params.provider === "demo-local" ? "demo-local" : undefined;
    return Boolean(expectedMarker && params.context.resolvedApiKey?.trim() === expectedMarker);
  },
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: ({ provider }: { provider: string }) =>
    provider === "openai" ? ["openai"] : [],
}));

const cliCredentialMocks = vi.hoisted(() => ({
  readClaudeCliCredentialsCached: vi.fn<(options?: unknown) => ClaudeCliCredential | null>(
    () => null,
  ),
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
}));

vi.mock("./cli-credentials.js", () => cliCredentialMocks);

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  cliCredentialMocks.readClaudeCliCredentialsCached.mockReset().mockReturnValue(null);
  cliCredentialMocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
  cliCredentialMocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

const envVar = (...parts: string[]) => parts.join("_");

function createUsableOAuthExpiry(): number {
  return Date.now() + 30 * 60 * 1000;
}

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: createUsableOAuthExpiry(),
  accountId: "acct_123",
};

const BEDROCK_PROVIDER_CFG = {
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [],
      },
    },
  },
} as const;

async function resolveBedrockProvider() {
  return resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    store: { version: 1, profiles: {} },
    cfg: BEDROCK_PROVIDER_CFG as never,
  });
}

async function expectBedrockAuthSource(params: {
  env: Record<string, string | undefined>;
  expectedSource: string;
}) {
  await withEnvAsync(params.env, async () => {
    const resolved = await resolveBedrockProvider();
    expect(resolved.mode).toBe("aws-sdk");
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.source).toContain(params.expectedSource);
  });
}

function buildDemoLocalStore(keys: string[]) {
  return {
    version: 1 as const,
    profiles: Object.fromEntries(
      keys.map((key, index) => [
        index === 0 ? "demo-local:default" : `demo-local:${index + 1}`,
        {
          type: "api_key" as const,
          provider: "demo-local" as const,
          key,
        },
      ]),
    ),
  };
}

function buildDemoLocalProviderCfg(apiKey: string): OpenClawConfig {
  return {
    models: {
      providers: {
        "demo-local": {
          baseUrl: "https://local-provider.example",
          api: "openai-completions",
          apiKey,
          models: [],
        },
      },
    },
  };
}

async function resolveDemoLocalApiKey(params: {
  envApiKey: string | undefined;
  storedKeys: string[];
  configuredApiKey: string;
}) {
  let resolved!: Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
  await withEnvAsync({ DEMO_LOCAL_API_KEY: params.envApiKey }, async () => {
    resolved = await resolveApiKeyForProvider({
      provider: "demo-local",
      store: buildDemoLocalStore(params.storedKeys),
      cfg: buildDemoLocalProviderCfg(params.configuredApiKey),
    });
  });
  return resolved;
}

describe("getApiKeyForModel", () => {
  it("reads oauth auth-profiles entries from auth-profiles.json via explicit profile", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-oauth-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              ...oauthFixture,
            },
          },
        });

        const model = {
          id: "codex-mini-latest",
          provider: "openai-codex",
          api: "openai-codex-responses",
        } as Model<Api>;

        const store = ensureAuthProfileStore(process.env.OPENCLAW_AGENT_DIR, {
          allowKeychainPrompt: false,
        });
        const apiKey = await getApiKeyForModel({
          model,
          profileId: "openai-codex:default",
          store,
          agentDir: process.env.OPENCLAW_AGENT_DIR,
        });
        expect(apiKey.apiKey).toBe(oauthFixture.access);
      },
    );
  });

  it("suggests openai-codex when only Codex OAuth is configured", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-auth-",
        agentEnv: "main",
        env: {
          OPENAI_API_KEY: undefined,
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              ...oauthFixture,
            },
          },
        });

        let error: unknown = null;
        try {
          await resolveApiKeyForProvider({ provider: "openai" });
        } catch (err) {
          error = err;
        }
        expect(String(error)).toContain("openai/gpt-5.5");
      },
    );
  });

  it("does not read unrelated external CLI credentials when resolving provider auth", async () => {
    cliCredentialMocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
      expires: createUsableOAuthExpiry(),
    });

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-auth-scope-",
        agentEnv: "main",
        env: {
          OPENAI_API_KEY: undefined,
        },
      },
      async () => {
        await expect(resolveApiKeyForProvider({ provider: "openai" })).rejects.toThrow(
          'No API key found for provider "openai".',
        );
      },
    );

    expect(cliCredentialMocks.readClaudeCliCredentialsCached).not.toHaveBeenCalled();
    expect(cliCredentialMocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(cliCredentialMocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("reads Claude CLI credentials when the Claude CLI provider is resolved", async () => {
    cliCredentialMocks.readClaudeCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-cli-access",
      refresh: "claude-cli-refresh",
      expires: createUsableOAuthExpiry(),
    });

    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-auth-claude-cli-",
        agentEnv: "main",
      },
      async () => {
        const resolved = await resolveApiKeyForProvider({ provider: "claude-cli" });
        expect(resolved).toMatchObject({
          apiKey: "claude-cli-access",
          profileId: "anthropic:claude-cli",
          source: "profile:anthropic:claude-cli",
          mode: "oauth",
        });
      },
    );

    expect(cliCredentialMocks.readClaudeCliCredentialsCached).toHaveBeenCalledWith(
      expect.objectContaining({ allowKeychainPrompt: false }),
    );
  });

  it("throws when ZAI API key is missing", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
      async () => {
        let error: unknown = null;
        try {
          await resolveApiKeyForProvider({
            provider: "zai",
            store: { version: 1, profiles: {} },
          });
        } catch (err) {
          error = err;
        }

        expect(String(error)).toContain('No API key found for provider "zai".');
      },
    );
  });

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: "zai-test-key", // pragma: allowlist secret
      },
      async () => {
        const resolved = await resolveApiKeyForProvider({
          provider: "zai",
          store: { version: 1, profiles: {} },
        });
        expect(resolved.apiKey).toBe("zai-test-key");
        expect(resolved.source).toContain("Z_AI_API_KEY");
      },
    );
  });

  it("keeps stored provider auth ahead of env by default", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "env-openai-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "stored-openai-key",
            },
          },
        },
      });
      expect(resolved.apiKey).toBe("stored-openai-key");
      expect(resolved.source).toBe("profile:openai:default");
      expect(resolved.profileId).toBe("openai:default");
    });
  });

  it("supports env-first precedence for live auth probes", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "env-openai-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        credentialPrecedence: "env-first",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "stored-openai-key",
            },
          },
        },
      });
      expect(resolved.apiKey).toBe("env-openai-key");
      expect(resolved.source).toContain("OPENAI_API_KEY");
      expect(resolved.profileId).toBeUndefined();
    });
  });

  it("uses trusted workspace manifest auth evidence in runtime auth checks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-cloud-auth-"));
    const credentialsPath = path.join(tempDir, "credentials.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["workspace-cloud"],
      },
    };

    try {
      await withEnvAsync({ WORKSPACE_CLOUD_CREDENTIALS: credentialsPath }, async () => {
        const store = { version: 1 as const, profiles: {} };
        const resolved = await resolveApiKeyForProvider({
          provider: "workspace-cloud",
          cfg,
          store,
        });

        expect(resolved).toEqual({
          apiKey: "workspace-cloud-local-credentials",
          source: "workspace cloud credentials",
          mode: "api-key",
        });
        expect(resolveModelAuthMode("workspace-cloud", cfg, store)).toBe("api-key");
        await expect(
          hasAvailableAuthForProvider({
            provider: "workspace-cloud",
            cfg,
            store,
          }),
        ).resolves.toBe(true);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores untrusted workspace manifest auth evidence in runtime auth checks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-cloud-auth-"));
    const credentialsPath = path.join(tempDir, "credentials.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    try {
      await withEnvAsync({ WORKSPACE_CLOUD_CREDENTIALS: credentialsPath }, async () => {
        const store = { version: 1 as const, profiles: {} };
        expect(resolveModelAuthMode("workspace-cloud", { plugins: {} }, store)).toBe("unknown");
        await expect(
          hasAvailableAuthForProvider({
            provider: "workspace-cloud",
            cfg: { plugins: {} },
            store,
          }),
        ).resolves.toBe(false);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the same trusted workspace manifest auth evidence in provider auth checks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-cloud-auth-"));
    const credentialsPath = path.join(tempDir, "credentials.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");
    const store = { version: 1 as const, profiles: {} };

    try {
      await withEnvAsync({ WORKSPACE_CLOUD_CREDENTIALS: credentialsPath }, async () => {
        expect(
          hasAuthForModelProvider({
            provider: "workspace-cloud",
            cfg: { plugins: { allow: ["workspace-cloud"] } },
            store,
          }),
        ).toBe(true);
        expect(
          hasAuthForModelProvider({
            provider: "workspace-cloud",
            cfg: { plugins: {} },
            store,
          }),
        ).toBe(false);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses runtime auth availability for provider auth checks", () => {
    const store = { version: 1 as const, profiles: {} };
    const localNoKeyConfig = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [testModelDefinition("meta-llama/Meta-Llama-3-8B-Instruct")],
          },
          remote: {
            api: "openai-completions",
            baseUrl: "https://remote.example.com/v1",
            models: [testModelDefinition("remote-model")],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasAuthForModelProvider({
        provider: "amazon-bedrock",
        cfg: {} as OpenClawConfig,
        env: {},
        store,
      }),
    ).toBe(true);
    expect(
      hasAuthForModelProvider({
        provider: "vllm",
        cfg: localNoKeyConfig,
        env: {},
        store,
      }),
    ).toBe(true);
    expect(
      hasAuthForModelProvider({
        provider: "remote",
        cfg: localNoKeyConfig,
        env: {},
        store,
      }),
    ).toBe(false);
  });

  it("hasAvailableAuthForProvider('google') accepts GOOGLE_API_KEY fallback", async () => {
    await withEnvAsync(
      {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: "google-test-key", // pragma: allowlist secret
      },
      async () => {
        await expect(
          hasAvailableAuthForProvider({
            provider: "google",
            store: { version: 1, profiles: {} },
          }),
        ).resolves.toBe(true);
      },
    );
  });

  it("hasAvailableAuthForProvider returns false when no provider auth is available", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
      async () => {
        await expect(
          hasAvailableAuthForProvider({
            provider: "zai",
            store: { version: 1, profiles: {} },
          }),
        ).resolves.toBe(false);
      },
    );
  });

  it("resolves Synthetic API key from env", async () => {
    await withEnvAsync({ [envVar("SYNTHETIC", "API", "KEY")]: "synthetic-test-key" }, async () => {
      // pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    });
  });

  it("resolves Qianfan API key from env", async () => {
    await withEnvAsync({ [envVar("QIANFAN", "API", "KEY")]: "qianfan-test-key" }, async () => {
      // pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "qianfan",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("qianfan-test-key");
      expect(resolved.source).toContain("QIANFAN_API_KEY");
    });
  });

  it("resolves Qwen API key from env", async () => {
    await withEnvAsync(
      { [envVar("MODELSTUDIO", "API", "KEY")]: "modelstudio-test-key" },
      async () => {
        // pragma: allowlist secret
        const resolved = await resolveApiKeyForProvider({
          provider: "qwen",
          store: { version: 1, profiles: {} },
        });
        expect(resolved.apiKey).toBe("modelstudio-test-key");
        expect(resolved.source).toContain("MODELSTUDIO_API_KEY");
      },
    );
  });

  it("resolves plugin-owned synthetic local auth for a configured provider without apiKey", async () => {
    await withEnvAsync({ DEMO_LOCAL_API_KEY: undefined }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "demo-local",
        store: { version: 1, profiles: {} },
        cfg: {
          models: {
            providers: {
              "demo-local": {
                baseUrl: "http://local-provider:11434",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
      });
      expect(resolved.apiKey).toBe("demo-local");
      expect(resolved.mode).toBe("api-key");
      expect(resolved.source).toContain("synthetic local key");
    });
  });

  it("does not mint synthetic local auth for empty provider stubs", async () => {
    await withEnvAsync({ DEMO_LOCAL_API_KEY: undefined }, async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "demo-local",
          store: { version: 1, profiles: {} },
          cfg: {
            models: {
              providers: {
                "demo-local": {
                  baseUrl: "",
                  models: [],
                },
              },
            },
          },
        }),
      ).rejects.toThrow(/No API key found for provider "demo-local"/);
    });
  });

  it("prefers explicit provider env auth over synthetic local key", async () => {
    await withEnvAsync({ [envVar("DEMO", "LOCAL", "API", "KEY")]: "env-demo-key" }, async () => {
      // pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "demo-local",
        store: { version: 1, profiles: {} },
        cfg: {
          models: {
            providers: {
              "demo-local": {
                baseUrl: "http://local-provider:11434",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
      });
      expect(resolved.apiKey).toBe("env-demo-key");
      expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
    });
  });

  it("prefers explicit provider env auth over a stored synthetic local profile", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: "env-demo-key",
      storedKeys: ["demo-local"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("env-demo-key");
    expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
    expect(resolved.profileId).toBeUndefined();
  });

  it("prefers explicit configured apiKey over a stored synthetic local profile", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: undefined,
      storedKeys: ["demo-local"],
      configuredApiKey: "config-demo-key",
    });
    expect(resolved.apiKey).toBe("config-demo-key");
    expect(resolved.source).toBe("models.json");
    expect(resolved.profileId).toBeUndefined();
  });

  it("falls back to the stored synthetic local profile when no real auth exists", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: undefined,
      storedKeys: ["demo-local"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("demo-local");
    expect(resolved.source).toBe("profile:demo-local:default");
    expect(resolved.profileId).toBe("demo-local:default");
  });

  it("keeps a real stored profile ahead of env auth", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: "env-demo-key",
      storedKeys: ["stored-demo-key"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("stored-demo-key");
    expect(resolved.source).toBe("profile:demo-local:default");
    expect(resolved.profileId).toBe("demo-local:default");
  });

  it("defers every stored synthetic local profile until real auth sources are checked", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: "env-demo-key",
      storedKeys: ["demo-local", "demo-local"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("env-demo-key");
    expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
    expect(resolved.profileId).toBeUndefined();
  });

  it("defers plugin-owned synthetic profile markers without core provider branching", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "demo-local",
      store: {
        version: 1,
        profiles: {
          "demo-local:default": {
            type: "api_key",
            provider: "demo-local",
            key: "demo-local",
          },
        },
      },
      cfg: {
        models: {
          providers: {
            "demo-local": {
              baseUrl: "http://localhost:11434",
              api: "openai-completions",
              apiKey: "config-demo-key",
              models: [],
            },
          },
        },
      },
    });
    expect(resolved.apiKey).toBe("config-demo-key");
    expect(resolved.source).toBe("models.json");
    expect(resolved.profileId).toBeUndefined();
  });

  it("still throws when no env/profile/config provider auth is available", async () => {
    await withEnvAsync({ DEMO_LOCAL_API_KEY: undefined }, async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "demo-local",
          store: { version: 1, profiles: {} },
        }),
      ).rejects.toThrow('No API key found for provider "demo-local".');
    });
  });

  it("resolves Vercel AI Gateway API key from env", async () => {
    await withEnvAsync({ [envVar("AI_GATEWAY", "API", "KEY")]: "gateway-test-key" }, async () => {
      // pragma: allowlist secret
      const resolved = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("gateway-test-key");
      expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
    });
  });

  it("prefers Bedrock bearer token over access keys and profile", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token", // pragma: allowlist secret
        AWS_ACCESS_KEY_ID: "access-key",
        [envVar("AWS", "SECRET", "ACCESS", "KEY")]: "secret-key", // pragma: allowlist secret
        AWS_PROFILE: "profile",
      },
      expectedSource: "AWS_BEARER_TOKEN_BEDROCK",
    });
  });

  it("prefers Bedrock access keys over profile", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: "access-key",
        [envVar("AWS", "SECRET", "ACCESS", "KEY")]: "secret-key", // pragma: allowlist secret
        AWS_PROFILE: "profile",
      },
      expectedSource: "AWS_ACCESS_KEY_ID",
    });
  });

  it("uses Bedrock profile when access keys are missing", async () => {
    await expectBedrockAuthSource({
      env: {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_PROFILE: "profile",
      },
      expectedSource: "AWS_PROFILE",
    });
  });

  it("accepts VOYAGE_API_KEY for voyage", async () => {
    await withEnvAsync({ [envVar("VOYAGE", "API", "KEY")]: "voyage-test-key" }, async () => {
      // pragma: allowlist secret
      const voyage = await resolveApiKeyForProvider({
        provider: "voyage",
        store: { version: 1, profiles: {} },
      });
      expect(voyage.apiKey).toBe("voyage-test-key");
      expect(voyage.source).toContain("VOYAGE_API_KEY");
    });
  });

  it("strips embedded CR/LF from ANTHROPIC_API_KEY", async () => {
    await withEnvAsync({ [envVar("ANTHROPIC", "API", "KEY")]: "sk-ant-test-\r\nkey" }, async () => {
      // pragma: allowlist secret
      const resolved = resolveEnvApiKey("anthropic");
      expect(resolved?.apiKey).toBe("sk-ant-test-key");
      expect(resolved?.source).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("resolveEnvApiKey('huggingface') returns HUGGINGFACE_HUB_TOKEN when set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: "hf_hub_xyz",
        HF_TOKEN: undefined,
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_xyz");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') prefers HUGGINGFACE_HUB_TOKEN over HF_TOKEN when both set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: "hf_hub_first",
        HF_TOKEN: "hf_second",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_first");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') returns HF_TOKEN when only HF_TOKEN set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: undefined,
        HF_TOKEN: "hf_abc123",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_abc123");
        expect(resolved?.source).toContain("HF_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('opencode-go') falls back to OPENCODE_ZEN_API_KEY", async () => {
    await withEnvAsync(
      {
        OPENCODE_API_KEY: undefined,
        OPENCODE_ZEN_API_KEY: "sk-opencode-zen-fallback", // pragma: allowlist secret
      },
      async () => {
        const resolved = resolveEnvApiKey("opencode-go");
        expect(resolved?.apiKey).toBe("sk-opencode-zen-fallback");
        expect(resolved?.source).toContain("OPENCODE_ZEN_API_KEY");
      },
    );
  });

  it("resolveEnvApiKey('minimax-portal') accepts MINIMAX_OAUTH_TOKEN", async () => {
    await withEnvAsync(
      {
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token",
        MINIMAX_API_KEY: undefined,
      },
      async () => {
        const resolved = resolveEnvApiKey("minimax-portal");
        expect(resolved?.apiKey).toBe("minimax-oauth-token");
        expect(resolved?.source).toContain("MINIMAX_OAUTH_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('anthropic-vertex') uses the provided env snapshot", async () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      GOOGLE_CLOUD_PROJECT_ID: "vertex-project",
    } as NodeJS.ProcessEnv);

    expect(resolved).toBeNull();
  });

  it("resolveEnvApiKey('google-vertex') uses the provided env snapshot", async () => {
    const resolved = resolveEnvApiKey("google-vertex", {
      GOOGLE_CLOUD_API_KEY: "google-cloud-api-key",
    } as NodeJS.ProcessEnv);

    expect(resolved?.apiKey).toBe("google-cloud-api-key");
    expect(resolved?.source).toBe("env: GOOGLE_CLOUD_API_KEY");
  });

  it("resolveEnvApiKey('google-vertex') accepts ADC credentials from the provided env snapshot", async () => {
    await expectVertexAdcEnvApiKey({
      provider: "google-vertex",
      credentialsJson: "{}",
      tempPrefix: "openclaw-google-adc-",
      env: {
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      },
    });
  });

  it("resolveEnvApiKey('google-vertex') accepts Unicode explicit ADC credential paths", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-unicode-"));
    const explicitDir = path.join(homeDir, "認証情報");
    const fallbackDir = path.join(homeDir, ".config", "gcloud");
    const explicitCredentialsPath = path.join(explicitDir, "adc.json");
    await fs.mkdir(explicitDir, { recursive: true });
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(explicitCredentialsPath, "{}", "utf8");
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: explicitCredentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
        HOME: homeDir,
      } as NodeJS.ProcessEnv);

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') accepts Unicode ADC fallback home paths", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-home-"));
    const homeDir = path.join(tempDir, "認証情報-home");
    const fallbackDir = path.join(homeDir, ".config", "gcloud");
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
        HOME: homeDir,
      } as NodeJS.ProcessEnv);

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') rejects GOOGLE_CLOUD_PROJECT_ID-only ADC auth evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-project-id-"));
    const credentialsPath = path.join(tempDir, "adc.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT_ID: "vertex-project",
      } as NodeJS.ProcessEnv);

      expect(resolved).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') accepts Windows APPDATA ADC fallback evidence", async () => {
    const appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-appdata-"));
    const fallbackDir = path.join(appDataDir, "gcloud");
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        APPDATA: appDataDir,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      } as NodeJS.ProcessEnv);

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(appDataDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') does not synthesize APPDATA from USERPROFILE", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-home-"));
    const userProfileDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-google-adc-userprofile-"),
    );
    const fallbackDir = path.join(userProfileDir, "AppData", "Roaming", "gcloud");
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        HOME: homeDir,
        USERPROFILE: userProfileDir,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      } as NodeJS.ProcessEnv);

      expect(resolved).toBeNull();
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(userProfileDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') keeps ADC fallback when manifest env candidates are empty", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-candidates-"));
    const credentialsPath = path.join(tempDir, "adc.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    try {
      const resolved = resolveEnvApiKey(
        "google-vertex",
        {
          GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
        } as NodeJS.ProcessEnv,
        { candidateMap: { "google-vertex": ["GOOGLE_CLOUD_API_KEY"] } },
      );

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('google-vertex') rejects missing explicit ADC path before fallback paths", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-adc-home-"));
    const fallbackDir = path.join(homeDir, ".config", "gcloud");
    const missingCredentialsPath = path.join(homeDir, "missing-adc.json");
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    try {
      const resolved = resolveEnvApiKey("google-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: missingCredentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
        HOME: homeDir,
      } as NodeJS.ProcessEnv);

      expect(resolved).toBeNull();
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts GOOGLE_APPLICATION_CREDENTIALS with project_id", async () => {
    await expectVertexAdcEnvApiKey({
      provider: "anthropic-vertex",
      credentialsJson: JSON.stringify({ project_id: "vertex-project" }),
    });
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts GOOGLE_APPLICATION_CREDENTIALS without a local project field", async () => {
    await expectVertexAdcEnvApiKey({
      provider: "anthropic-vertex",
      credentialsJson: "{}",
    });
  });

  it("resolveEnvApiKey('anthropic-vertex') accepts explicit metadata auth opt-in", async () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
    } as NodeJS.ProcessEnv);

    expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
    expect(resolved?.source).toBe("gcloud adc");
  });
});
