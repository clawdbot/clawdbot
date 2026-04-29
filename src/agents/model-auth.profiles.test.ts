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
import {
  getApiKeyForModel,
  hasAvailableAuthForProvider,
  resolveApiKeyForProvider,
  resolveEnvApiKey,
} from "./model-auth.js";

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
  const candidates = {
    anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
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

vi.mock("./cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
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
    expect(resolved?.source).toBe("gcloud adc");
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
