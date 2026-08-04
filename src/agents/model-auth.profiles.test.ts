// Covers model auth resolution across env, profiles, CLI, and provider aliases.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";
import type { ClaudeCliCredential } from "./cli-credentials.js";
import {
  createRuntimeProviderAuthLookup,
  getApiKeyForModel,
  hasAvailableAuthForProvider,
  hasRuntimeAvailableProviderAuth,
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
  // Vertex ADC credentials are file evidence, not a raw API key. Tests create
  // a temporary credentials file and expect the non-secret marker to win.
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

async function withTempFiles<T>(
  prefix: string,
  files: Record<string, string>,
  run: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(tempDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withWorkspaceCredentials<T>(run: () => Promise<T>): Promise<T> {
  return withTempFiles("openclaw-workspace-cloud-auth-", { "credentials.json": "{}" }, (dir) =>
    withEnvAsync({ WORKSPACE_CLOUD_CREDENTIALS: path.join(dir, "credentials.json") }, run),
  );
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
  // Workspace-provided auth evidence is only trusted when the plugin is in the
  // effective allowlist, mirroring runtime plugin scoping.
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
  const aliasMap = {
    modelstudio: "qwen",
    qwencloud: "qwen",
    "z.ai": "zai",
    "z-ai": "zai",
    "opencode-go-auth": "opencode-go",
    bedrock: "amazon-bedrock",
    "aws-bedrock": "amazon-bedrock",
  };
  const resolveMockProviderAuthEvidence = (params?: { config?: OpenClawConfig }) => {
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
  };
  return {
    listKnownProviderEnvApiKeyNames: () => [...new Set(Object.values(candidates).flat())],
    resolveProviderEnvAuthLookupMaps: (params?: { config?: OpenClawConfig }) => ({
      aliasMap,
      envCandidateMap: candidates,
      authEvidenceMap: resolveMockProviderAuthEvidence(params),
      setupProviderFallbackRefs: ["anthropic-vertex"],
    }),
  };
});

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: (params: {
    provider: string;
    context: { listProfileIds: (providerId: string) => string[] };
  }) => {
    if (params.provider === "openai" && params.context.listProfileIds("openai").length > 0) {
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
  resolveOwningPluginIdsForProviderRef: ({ provider }: { provider: string }) =>
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

const createUsableOAuthExpiry = () => Date.now() + 30 * 60 * 1000;

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: createUsableOAuthExpiry(),
  accountId: "acct_123",
};

const claudeCliFixture: ClaudeCliCredential = {
  type: "oauth",
  provider: "anthropic",
  access: "claude-cli-access",
  refresh: "claude-cli-refresh",
  expires: createUsableOAuthExpiry(),
};

function authStore(profiles: AuthProfileStore["profiles"] = {}): AuthProfileStore {
  return { version: 1, profiles };
}

function apiKeyStore(profileId: string, provider: string, key?: string): AuthProfileStore {
  return authStore({
    [profileId]: { type: "api_key", provider, ...(key === undefined ? {} : { key }) },
  });
}

function tokenStore(profileId: string, provider: string, token: string): AuthProfileStore {
  return authStore({ [profileId]: { type: "token", provider, token } });
}

function oauthStore(
  profileId: string,
  provider: string,
  credential: Omit<OAuthCredential, "type" | "provider"> = oauthFixture,
): AuthProfileStore {
  return authStore({ [profileId]: { type: "oauth", provider, ...credential } });
}

function openAiModel(api: "openai-responses" | "openai-chatgpt-responses", id: string): Model {
  return { id, provider: "openai", api } as Model;
}

function openRouterEntryConfig(
  apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
  options: {
    auth?: "api-key";
    includeCanonical?: boolean;
    order?: string[];
    provider?: string;
    baseUrl?: string;
  } = {},
): OpenClawConfig {
  const provider = options.provider ?? "openrouter-minimax";
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const providers: NonNullable<OpenClawConfig["models"]>["providers"] = {
    ...(options.includeCanonical === false
      ? {}
      : {
          openrouter: {
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            models: [],
          },
        }),
    [provider]: {
      api: "openai-completions",
      baseUrl,
      apiKey,
      ...(options.auth ? { auth: options.auth } : {}),
      models: [],
    },
  };
  return {
    models: { providers },
    ...(options.order ? { auth: { order: { openrouter: options.order } } } : {}),
  };
}

function openAiEntryConfig(
  apiKey: string,
  api: "openai-completions" | "openai-responses" = "openai-completions",
): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api,
          baseUrl: "https://api.openai.com/v1",
          apiKey,
          models: [],
        },
      },
    },
  };
}

async function resolveProviderFromEnv(
  provider: string,
  env: Record<string, string | undefined>,
  options: Omit<Parameters<typeof resolveApiKeyForProvider>[0], "provider"> = {},
) {
  return withEnvAsync(env, () =>
    resolveApiKeyForProvider({ store: authStore(), ...options, provider }),
  );
}

async function resolveEnvApiKeyFromEnv(provider: string, env: Record<string, string | undefined>) {
  return withEnvAsync(env, async () => resolveEnvApiKey(provider));
}

async function hasProviderAuthFromEnv(provider: string, env: Record<string, string | undefined>) {
  return withEnvAsync(env, () => hasAvailableAuthForProvider({ provider, store: authStore() }));
}

function withAuthState(
  prefix: string,
  run: Parameters<typeof withOpenClawTestState>[1],
  options: { agentEnv?: "clear" | "main"; env?: Record<string, string | undefined> } = {},
) {
  return withOpenClawTestState(
    { layout: "state-only", prefix, agentEnv: options.agentEnv ?? "main", env: options.env },
    run,
  );
}

function defaultAgentConfig(agentDir: string): OpenClawConfig {
  return { agents: { list: [{ id: "configured", default: true, agentDir }] } };
}

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

const BEDROCK_PROVIDER_CFG_WITH_PROFILE = {
  ...BEDROCK_PROVIDER_CFG,
  auth: {
    order: {
      "amazon-bedrock": ["amazon-bedrock:default"],
    },
    profiles: {
      "amazon-bedrock:default": {
        provider: "amazon-bedrock",
        mode: "aws-sdk",
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

it("resolves config-only aws-sdk profiles without stored credentials", async () => {
  const resolved = await resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    profileId: "amazon-bedrock:default",
    store: { version: 1, profiles: {} },
    cfg: BEDROCK_PROVIDER_CFG_WITH_PROFILE as never,
  });

  expect(resolved.mode).toBe("aws-sdk");
  expect(resolved.profileId).toBe("amazon-bedrock:default");
  expect(resolved.source).toBe("profile:amazon-bedrock:default");
  expect(resolved.apiKey).toBeUndefined();
});

it("uses configured aws-sdk profile order without stored credentials", async () => {
  const resolved = await resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    store: { version: 1, profiles: {} },
    cfg: BEDROCK_PROVIDER_CFG_WITH_PROFILE as never,
  });

  expect(resolved.mode).toBe("aws-sdk");
  expect(resolved.profileId).toBe("amazon-bedrock:default");
  expect(resolved.source).toBe("profile:amazon-bedrock:default");
  expect(resolved.apiKey).toBeUndefined();
});

function buildDemoLocalStore(keys: string[]) {
  return authStore(
    Object.fromEntries(
      keys.map((key, index) => [
        index === 0 ? "demo-local:default" : `demo-local:${index + 1}`,
        { type: "api_key", provider: "demo-local", key },
      ]),
    ),
  );
}

function buildDemoLocalProviderCfg(
  apiKey?: string,
  options: { baseUrl?: string; omitApi?: boolean } = {},
): OpenClawConfig {
  return {
    models: {
      providers: {
        "demo-local": {
          baseUrl: options.baseUrl ?? "https://local-provider.example",
          ...(options.omitApi ? {} : { api: "openai-completions" as const }),
          ...(apiKey === undefined ? {} : { apiKey }),
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
  return resolveProviderFromEnv(
    "demo-local",
    { DEMO_LOCAL_API_KEY: params.envApiKey },
    {
      store: buildDemoLocalStore(params.storedKeys),
      cfg: buildDemoLocalProviderCfg(params.configuredApiKey),
    },
  );
}

describe("getApiKeyForModel", () => {
  it("reads oauth auth-profiles entries from auth-profiles.json via explicit profile", async () => {
    await withAuthState("openclaw-oauth-", async (state) => {
      await state.writeAuthProfiles(oauthStore("openai:default", "openai"));

      const store = ensureAuthProfileStore(process.env.OPENCLAW_AGENT_DIR, {
        allowKeychainPrompt: false,
      });
      const apiKey = await getApiKeyForModel({
        model: openAiModel("openai-chatgpt-responses", "codex-mini-latest"),
        profileId: "openai:default",
        store,
        agentDir: process.env.OPENCLAW_AGENT_DIR,
      });
      expect(apiKey.apiKey).toBe(oauthFixture.access);
    });
  });

  it("keeps OpenAI OAuth profiles on the Codex transport and API keys on direct OpenAI", async () => {
    const store = authStore({
      "openai:chatgpt": { type: "oauth", provider: "openai", ...oauthFixture },
      "openai:api-key": { type: "api_key", provider: "openai", key: "direct-openai-key" },
    });

    const directAuth = await getApiKeyForModel({
      model: openAiModel("openai-responses", "chat-latest"),
      store,
    });
    const codexAuth = await getApiKeyForModel({
      model: openAiModel("openai-chatgpt-responses", "gpt-5.5"),
      store,
    });

    expect(directAuth).toMatchObject({
      apiKey: "direct-openai-key",
      mode: "api-key",
      profileId: "openai:api-key",
    });
    expect(codexAuth).toMatchObject({
      apiKey: oauthFixture.access,
      mode: "oauth",
      profileId: "openai:chatgpt",
    });
  });

  it("rejects an explicit OpenAI OAuth profile for direct OpenAI Platform models", async () => {
    await expect(
      getApiKeyForModel({
        model: openAiModel("openai-responses", "chat-latest"),
        profileId: "openai:chatgpt",
        lockedProfile: true,
        store: oauthStore("openai:chatgpt", "openai"),
      }),
    ).rejects.toThrow(/requires an OpenAI API key profile/);
  });

  it("rejects an explicit OpenAI API-key profile for the Codex transport", async () => {
    await expect(
      getApiKeyForModel({
        model: openAiModel("openai-chatgpt-responses", "gpt-5.5"),
        profileId: "openai:api-key",
        lockedProfile: true,
        store: apiKeyStore("openai:api-key", "openai", "direct-openai-key"),
      }),
    ).rejects.toThrow(/requires a ChatGPT subscription \(OAuth or token\) profile/);
  });

  it("uses the config default agent dir when resolving provider profiles", async () => {
    await withAuthState(
      "openclaw-auth-agent-dir-",
      async (state) => {
        await state.writeAuthProfiles(
          apiKeyStore("xai:default", "xai", "process-default-key"),
          "main",
        );
        await state.writeAuthProfiles(
          apiKeyStore("xai:default", "xai", "configured-agent-key"),
          "configured",
        );

        const cfg = defaultAgentConfig(state.agentDir("configured"));

        const resolved = await resolveApiKeyForProvider({ provider: "xai", cfg });
        expect(resolved.apiKey).toBe("configured-agent-key");
        expect(resolved.source).toBe("profile:xai:default");
      },
      { agentEnv: "clear", env: { XAI_API_KEY: undefined } },
    );
  });

  it("reports the config default agent dir when provider auth is missing", async () => {
    await withAuthState(
      "openclaw-auth-missing-agent-dir-",
      async (state) => {
        const configuredAgentDir = state.agentDir("configured");
        const cfg = defaultAgentConfig(configuredAgentDir);

        await expect(resolveApiKeyForProvider({ provider: "xai", cfg })).rejects.toThrow(
          `agentDir: ${configuredAgentDir}`,
        );
      },
      { agentEnv: "clear", env: { XAI_API_KEY: undefined } },
    );
  });

  it("uses OpenAI OAuth when it is configured for the provider", async () => {
    await withAuthState(
      "openclaw-auth-",
      async (state) => {
        await state.writeAuthProfiles(oauthStore("openai:default", "openai"));

        const resolved = await resolveApiKeyForProvider({ provider: "openai" });

        expect(resolved).toMatchObject({
          apiKey: oauthFixture.access,
          mode: "oauth",
          profileId: "openai:default",
        });
      },
      { env: { OPENAI_API_KEY: undefined } },
    );
  });

  it("does not read unrelated external CLI credentials when resolving provider auth", async () => {
    cliCredentialMocks.readClaudeCliCredentialsCached.mockReturnValue(claudeCliFixture);

    await withAuthState(
      "openclaw-auth-scope-",
      async () => {
        await expect(resolveApiKeyForProvider({ provider: "openai" })).rejects.toMatchObject({
          code: "missing-provider-auth",
          message: expect.stringContaining('No API key found for provider "openai".'),
          provider: "openai",
        });
      },
      { env: { OPENAI_API_KEY: undefined } },
    );

    expect(cliCredentialMocks.readClaudeCliCredentialsCached).not.toHaveBeenCalled();
    expect(cliCredentialMocks.readCodexCliCredentialsCached).toHaveBeenCalled();
    expect(cliCredentialMocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("reads Claude CLI credentials when the Claude CLI provider is resolved", async () => {
    cliCredentialMocks.readClaudeCliCredentialsCached.mockReturnValue(claudeCliFixture);

    await withAuthState("openclaw-auth-claude-cli-", async () => {
      const resolved = await resolveApiKeyForProvider({ provider: "claude-cli" });
      expect(resolved.apiKey).toBe("claude-cli-access");
      expect(resolved.profileId).toBe("anthropic:claude-cli");
      expect(resolved.source).toBe("profile:anthropic:claude-cli");
      expect(resolved.mode).toBe("oauth");
    });

    const options = cliCredentialMocks.readClaudeCliCredentialsCached.mock.calls.at(0)?.[0] as
      | { allowKeychainPrompt?: boolean }
      | undefined;
    expect(options?.allowKeychainPrompt).toBe(false);
  });

  it("throws when ZAI API key is missing", async () => {
    let error: unknown = null;
    try {
      await resolveProviderFromEnv("zai", { ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined });
    } catch (err) {
      error = err;
    }
    expect(String(error)).toContain('No API key found for provider "zai".');
  });

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    const resolved = await resolveProviderFromEnv("zai", {
      ZAI_API_KEY: undefined,
      Z_AI_API_KEY: "zai-test-key", // pragma: allowlist secret
    });
    expect(resolved.apiKey).toBe("zai-test-key");
    expect(resolved.source).toContain("Z_AI_API_KEY");
  });

  it("skips malformed stored ZAI command profiles and uses current env auth", async () => {
    const resolved = await resolveProviderFromEnv(
      "zai",
      {
        ZAI_API_KEY: "zai-current-key", // pragma: allowlist secret
        Z_AI_API_KEY: undefined,
      },
      {
        store: apiKeyStore(
          "zai:default",
          "zai",
          "openclaw onboard --auth-choice zai-coding-global",
        ),
      },
    );
    expect(resolved.apiKey).toBe("zai-current-key");
    expect(resolved.source).toContain("ZAI_API_KEY");
    expect(resolved.profileId).toBeUndefined();
  });

  it("keeps stored provider auth ahead of env by default", async () => {
    const resolved = await resolveProviderFromEnv(
      "openai",
      { OPENAI_API_KEY: "env-openai-key" },
      { store: apiKeyStore("openai:default", "openai", "stored-openai-key") },
    );
    expect(resolved.apiKey).toBe("stored-openai-key");
    expect(resolved.source).toBe("profile:openai:default");
    expect(resolved.profileId).toBe("openai:default");
  });

  it("supports env-first precedence for live auth probes", async () => {
    const resolved = await resolveProviderFromEnv(
      "openai",
      { OPENAI_API_KEY: "env-openai-key" },
      {
        credentialPrecedence: "env-first",
        store: apiKeyStore("openai:default", "openai", "stored-openai-key"),
      },
    );
    expect(resolved.apiKey).toBe("env-openai-key");
    expect(resolved.source).toContain("OPENAI_API_KEY");
    expect(resolved.profileId).toBeUndefined();
  });

  it("uses trusted workspace manifest auth evidence in runtime auth checks", async () => {
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["workspace-cloud"],
      },
    };

    await withWorkspaceCredentials(async () => {
      const store = authStore();
      const resolved = await resolveApiKeyForProvider({ provider: "workspace-cloud", cfg, store });

      expect(resolved).toEqual({
        apiKey: "workspace-cloud-local-credentials",
        source: "workspace cloud credentials",
        mode: "api-key",
      });
      expect(resolveModelAuthMode("workspace-cloud", cfg, store)).toBe("api-key");
      await expect(
        hasAvailableAuthForProvider({ provider: "workspace-cloud", cfg, store }),
      ).resolves.toBe(true);
    });
  });

  it("ignores untrusted workspace manifest auth evidence in runtime auth checks", async () => {
    await withWorkspaceCredentials(async () => {
      const store = authStore();
      expect(resolveModelAuthMode("workspace-cloud", { plugins: {} }, store)).toBe("unknown");
      await expect(
        hasAvailableAuthForProvider({
          provider: "workspace-cloud",
          cfg: { plugins: {} },
          store,
        }),
      ).resolves.toBe(false);
    });
  });

  it("uses the same trusted workspace manifest auth evidence in provider auth checks", async () => {
    const store = authStore();
    await withWorkspaceCredentials(async () => {
      await expect(
        hasAuthForModelProvider({
          provider: "workspace-cloud",
          cfg: { plugins: { allow: ["workspace-cloud"] } },
          store,
        }),
      ).resolves.toBe(true);
      await expect(
        hasAuthForModelProvider({ provider: "workspace-cloud", cfg: { plugins: {} }, store }),
      ).resolves.toBe(false);
    });
  });

  it("reuses runtime auth availability for provider auth checks", async () => {
    const store = { version: 1 as const, profiles: {} };
    const localNoKeyConfig = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [{} as Model],
          },
          remote: {
            api: "openai-completions",
            baseUrl: "https://remote.example.com/v1",
            models: [{} as Model],
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      hasAuthForModelProvider({
        provider: "amazon-bedrock",
        cfg: {} as OpenClawConfig,
        env: {},
        store,
      }),
    ).resolves.toBe(false);
    await expect(
      hasAuthForModelProvider({
        provider: "vllm",
        cfg: localNoKeyConfig,
        env: {},
        store,
      }),
    ).resolves.toBe(true);
    await expect(
      hasAuthForModelProvider({
        provider: "remote",
        cfg: localNoKeyConfig,
        env: {},
        store,
      }),
    ).resolves.toBe(false);
  });

  it("hasAvailableAuthForProvider('google') accepts GOOGLE_API_KEY fallback", async () => {
    await expect(
      hasProviderAuthFromEnv("google", {
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: "google-test-key", // pragma: allowlist secret
      }),
    ).resolves.toBe(true);
  });

  it("hasAvailableAuthForProvider returns false when no provider auth is available", async () => {
    await expect(
      hasProviderAuthFromEnv("zai", { ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }),
    ).resolves.toBe(false);
  });

  it("resolves Synthetic API key from env", async () => {
    const resolved = await resolveProviderFromEnv("synthetic", {
      [envVar("SYNTHETIC", "API", "KEY")]: "synthetic-test-key", // pragma: allowlist secret
    });
    expect(resolved.apiKey).toBe("synthetic-test-key");
    expect(resolved.source).toContain("SYNTHETIC_API_KEY");
  });

  it("resolves Qianfan API key from env", async () => {
    const resolved = await resolveProviderFromEnv("qianfan", {
      [envVar("QIANFAN", "API", "KEY")]: "qianfan-test-key", // pragma: allowlist secret
    });
    expect(resolved.apiKey).toBe("qianfan-test-key");
    expect(resolved.source).toContain("QIANFAN_API_KEY");
  });

  it("resolves Qwen API key from env", async () => {
    const resolved = await resolveProviderFromEnv("qwen", {
      [envVar("MODELSTUDIO", "API", "KEY")]: "modelstudio-test-key", // pragma: allowlist secret
    });
    expect(resolved.apiKey).toBe("modelstudio-test-key");
    expect(resolved.source).toContain("MODELSTUDIO_API_KEY");
  });

  it("resolves plugin-owned synthetic local auth for a configured provider without apiKey", async () => {
    const resolved = await resolveProviderFromEnv(
      "demo-local",
      { DEMO_LOCAL_API_KEY: undefined },
      {
        store: authStore(),
        cfg: buildDemoLocalProviderCfg(undefined, { baseUrl: "http://local-provider:11434" }),
      },
    );
    expect(resolved.apiKey).toBe("demo-local");
    expect(resolved.mode).toBe("api-key");
    expect(resolved.source).toContain("synthetic local key");
  });

  it("does not mint synthetic local auth for empty provider stubs", async () => {
    await withEnvAsync({ DEMO_LOCAL_API_KEY: undefined }, async () => {
      await expect(
        resolveApiKeyForProvider({
          provider: "demo-local",
          store: authStore(),
          cfg: buildDemoLocalProviderCfg(undefined, { baseUrl: "", omitApi: true }),
        }),
      ).rejects.toThrow(/No API key found for provider "demo-local"/);
    });
  });

  it("prefers explicit provider env auth over synthetic local key", async () => {
    const resolved = await resolveProviderFromEnv(
      "demo-local",
      { [envVar("DEMO", "LOCAL", "API", "KEY")]: "env-demo-key" }, // pragma: allowlist secret
      {
        store: authStore(),
        cfg: buildDemoLocalProviderCfg(undefined, { baseUrl: "http://local-provider:11434" }),
      },
    );
    expect(resolved.apiKey).toBe("env-demo-key");
    expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
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
      store: apiKeyStore("demo-local:default", "demo-local", "demo-local"),
      cfg: buildDemoLocalProviderCfg("config-demo-key", { baseUrl: "http://localhost:11434" }),
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
    const resolved = await resolveProviderFromEnv("vercel-ai-gateway", {
      [envVar("AI_GATEWAY", "API", "KEY")]: "gateway-test-key", // pragma: allowlist secret
    });
    expect(resolved.apiKey).toBe("gateway-test-key");
    expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
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
    const voyage = await resolveProviderFromEnv("voyage", {
      [envVar("VOYAGE", "API", "KEY")]: "voyage-test-key", // pragma: allowlist secret
    });
    expect(voyage.apiKey).toBe("voyage-test-key");
    expect(voyage.source).toContain("VOYAGE_API_KEY");
  });

  it("strips embedded CR/LF from ANTHROPIC_API_KEY", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("anthropic", {
      [envVar("ANTHROPIC", "API", "KEY")]: "sk-ant-test-\r\nkey", // pragma: allowlist secret
    });
    expect(resolved?.apiKey).toBe("sk-ant-test-key");
    expect(resolved?.source).toContain("ANTHROPIC_API_KEY");
  });

  it("resolveEnvApiKey('huggingface') returns HUGGINGFACE_HUB_TOKEN when set", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("huggingface", {
      HUGGINGFACE_HUB_TOKEN: "hf_hub_xyz",
      HF_TOKEN: undefined,
    });
    expect(resolved?.apiKey).toBe("hf_hub_xyz");
    expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
  });

  it("resolveEnvApiKey('huggingface') prefers HUGGINGFACE_HUB_TOKEN over HF_TOKEN when both set", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("huggingface", {
      HUGGINGFACE_HUB_TOKEN: "hf_hub_first",
      HF_TOKEN: "hf_second",
    });
    expect(resolved?.apiKey).toBe("hf_hub_first");
    expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
  });

  it("resolveEnvApiKey('huggingface') returns HF_TOKEN when only HF_TOKEN set", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("huggingface", {
      HUGGINGFACE_HUB_TOKEN: undefined,
      HF_TOKEN: "hf_abc123",
    });
    expect(resolved?.apiKey).toBe("hf_abc123");
    expect(resolved?.source).toContain("HF_TOKEN");
  });

  it("resolveEnvApiKey('opencode-go') falls back to OPENCODE_ZEN_API_KEY", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("opencode-go", {
      OPENCODE_API_KEY: undefined,
      OPENCODE_ZEN_API_KEY: "sk-opencode-zen-fallback", // pragma: allowlist secret
    });
    expect(resolved?.apiKey).toBe("sk-opencode-zen-fallback");
    expect(resolved?.source).toContain("OPENCODE_ZEN_API_KEY");
  });

  it("resolveEnvApiKey('minimax-portal') accepts MINIMAX_OAUTH_TOKEN", async () => {
    const resolved = await resolveEnvApiKeyFromEnv("minimax-portal", {
      MINIMAX_OAUTH_TOKEN: "minimax-oauth-token",
      MINIMAX_API_KEY: undefined,
    });
    expect(resolved?.apiKey).toBe("minimax-oauth-token");
    expect(resolved?.source).toContain("MINIMAX_OAUTH_TOKEN");
  });

  it("resolveEnvApiKey('anthropic-vertex') uses the provided env snapshot", () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      GOOGLE_CLOUD_PROJECT_ID: "vertex-project",
    } as NodeJS.ProcessEnv);

    expect(resolved).toBeNull();
  });

  it("resolveEnvApiKey('google-vertex') uses the provided env snapshot", () => {
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
    await withTempFiles(
      "openclaw-google-adc-unicode-",
      {
        "認証情報/adc.json": "{}",
        ".config/gcloud/application_default_credentials.json": "{}",
      },
      async (homeDir) => {
        const resolved = resolveEnvApiKey("google-vertex", {
          GOOGLE_APPLICATION_CREDENTIALS: path.join(homeDir, "認証情報", "adc.json"),
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          HOME: homeDir,
        } as NodeJS.ProcessEnv);

        expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
        expect(resolved?.source).toBe("gcloud adc");
      },
    );
  });

  it("resolveEnvApiKey('google-vertex') accepts Unicode ADC fallback home paths", async () => {
    await withTempFiles(
      "openclaw-google-adc-home-",
      { "認証情報-home/.config/gcloud/application_default_credentials.json": "{}" },
      async (tempDir) => {
        const homeDir = path.join(tempDir, "認証情報-home");
        const resolved = resolveEnvApiKey("google-vertex", {
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          HOME: homeDir,
        } as NodeJS.ProcessEnv);

        expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
        expect(resolved?.source).toBe("gcloud adc");
      },
    );
  });

  it("resolveEnvApiKey('google-vertex') rejects GOOGLE_CLOUD_PROJECT_ID-only ADC auth evidence", async () => {
    await withTempFiles("openclaw-google-adc-project-id-", { "adc.json": "{}" }, async (dir) => {
      const resolved = resolveEnvApiKey("google-vertex", {
        GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, "adc.json"),
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT_ID: "vertex-project",
      } as NodeJS.ProcessEnv);

      expect(resolved).toBeNull();
    });
  });

  it("resolveEnvApiKey('google-vertex') accepts Windows APPDATA ADC fallback evidence", async () => {
    await withTempFiles(
      "openclaw-google-adc-appdata-",
      { "gcloud/application_default_credentials.json": "{}" },
      async (appDataDir) => {
        const resolved = resolveEnvApiKey("google-vertex", {
          APPDATA: appDataDir,
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
        } as NodeJS.ProcessEnv);

        expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
        expect(resolved?.source).toBe("gcloud adc");
      },
    );
  });

  it("resolveEnvApiKey('google-vertex') does not synthesize APPDATA from USERPROFILE", async () => {
    await withTempFiles("openclaw-google-adc-home-", {}, async (homeDir) => {
      await withTempFiles(
        "openclaw-google-adc-userprofile-",
        { "AppData/Roaming/gcloud/application_default_credentials.json": "{}" },
        async (userProfileDir) => {
          const resolved = resolveEnvApiKey("google-vertex", {
            HOME: homeDir,
            USERPROFILE: userProfileDir,
            GOOGLE_CLOUD_LOCATION: "us-central1",
            GOOGLE_CLOUD_PROJECT: "vertex-project",
          } as NodeJS.ProcessEnv);

          expect(resolved).toBeNull();
        },
      );
    });
  });

  it("resolveEnvApiKey('google-vertex') keeps ADC fallback when manifest env candidates are empty", async () => {
    await withTempFiles("openclaw-google-adc-candidates-", { "adc.json": "{}" }, async (dir) => {
      const resolved = resolveEnvApiKey(
        "google-vertex",
        {
          GOOGLE_APPLICATION_CREDENTIALS: path.join(dir, "adc.json"),
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
        } as NodeJS.ProcessEnv,
        { candidateMap: { "google-vertex": ["GOOGLE_CLOUD_API_KEY"] } },
      );

      expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
      expect(resolved?.source).toBe("gcloud adc");
    });
  });

  it("resolveEnvApiKey('google-vertex') rejects missing explicit ADC path before fallback paths", async () => {
    await withTempFiles(
      "openclaw-google-adc-home-",
      { ".config/gcloud/application_default_credentials.json": "{}" },
      async (homeDir) => {
        const resolved = resolveEnvApiKey("google-vertex", {
          GOOGLE_APPLICATION_CREDENTIALS: path.join(homeDir, "missing-adc.json"),
          GOOGLE_CLOUD_LOCATION: "us-central1",
          GOOGLE_CLOUD_PROJECT: "vertex-project",
          HOME: homeDir,
        } as NodeJS.ProcessEnv);

        expect(resolved).toBeNull();
      },
    );
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

  it("resolveEnvApiKey('anthropic-vertex') accepts explicit metadata auth opt-in", () => {
    const resolved = resolveEnvApiKey("anthropic-vertex", {
      ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
    } as NodeJS.ProcessEnv);

    expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
    expect(resolved?.source).toBe("gcloud adc");
  });

  it("resolveEnvApiKey skips plugin setup fallback when precomputed maps are authoritative", () => {
    const resolved = resolveEnvApiKey(
      "anthropic-vertex",
      {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
      } as NodeJS.ProcessEnv,
      {
        candidateMap: {},
        authEvidenceMap: {},
        skipSetupProviderFallback: true,
      },
    );

    expect(resolved).toBeNull();
  });

  it("prepared runtime auth lookup still allows setup fallback for manifest setup providers", () => {
    const runtimeLookup = createRuntimeProviderAuthLookup({ env: {} });

    expect(runtimeLookup.setupProviderFallbackRefs).toContain("anthropic-vertex");
    expect(
      hasRuntimeAvailableProviderAuth({
        provider: "anthropic-vertex",
        env: {
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        } as NodeJS.ProcessEnv,
        runtimeLookup,
      }),
    ).toBe(true);
  });

  it("prepared runtime auth lookup skips setup fallback for providers outside manifest setup refs", () => {
    const runtimeLookup = createRuntimeProviderAuthLookup({ env: {} });

    expect(
      hasRuntimeAvailableProviderAuth({
        provider: "other-vertex",
        env: {
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        } as NodeJS.ProcessEnv,
        runtimeLookup,
      }),
    ).toBe(false);
  });
});

describe("resolveApiKeyForProvider — per-entry apiKey as profile ID reference", () => {
  it("resolves actual credential when per-entry apiKey matches a profile ID in the store", async () => {
    // Scenario from #67423: openrouter-minimax.apiKey = "openrouter:key-b"
    // should resolve the actual key from that profile, not use the string literally.
    const resolved = await resolveApiKeyForProvider({
      provider: "openrouter-minimax",
      cfg: openRouterEntryConfig("openrouter:key-b"),
      store: apiKeyStore("openrouter:key-b", "openrouter", "sk-or-actual-key-b"),
    });

    expect(resolved.apiKey).toBe("sk-or-actual-key-b");
    expect(resolved.profileId).toBe("openrouter:key-b");
    expect(resolved.source).toBe("profile:openrouter:key-b");
    expect(resolved.mode).toBe("api-key");
  });

  it("does not treat a literal API key as a profile ID when no matching profile exists", async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "openrouter-minimax",
      cfg: openRouterEntryConfig("sk-or-literal-key"),
      store: authStore(),
    });

    expect(resolved.apiKey).toBe("sk-or-literal-key");
    expect(resolved.profileId).toBeUndefined();
    expect(resolved.source).toBe("models.json");
  });

  it("does not treat env SecretRef ids as profile references", async () => {
    await withEnvAsync({ OPENROUTER_PROFILE: "sk-or-env-secret" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "openrouter-minimax",
        cfg: openRouterEntryConfig(
          { source: "env", provider: "default", id: "OPENROUTER_PROFILE" },
          { includeCanonical: false },
        ),
        store: apiKeyStore("OPENROUTER_PROFILE", "openrouter", "sk-or-wrong-profile"),
      });

      expect(resolved.apiKey).toBe("sk-or-env-secret");
      expect(resolved.source).toContain("OPENROUTER_PROFILE");
    });
  });

  it("keeps env-first precedence ahead of per-entry profile references", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "sk-env-first" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "openai",
        credentialPrecedence: "env-first",
        cfg: openAiEntryConfig("openai:key-b"),
        store: apiKeyStore("openai:key-b", "openai", "sk-profile-key"),
      });

      expect(resolved.apiKey).toBe("sk-env-first");
      expect(resolved.source).toContain("OPENAI_API_KEY");
    });
  });

  it("does not bleed auth.order canonical provider profiles into a per-entry provider", async () => {
    // auth.order.openrouter should not be selected when resolving openrouter-minimax
    // that has its own per-entry apiKey = "openrouter:key-b" profile reference.
    const resolved = await resolveApiKeyForProvider({
      provider: "openrouter-minimax",
      cfg: openRouterEntryConfig("openrouter:key-b", {
        order: ["openrouter:key-a", "openrouter:key-b", "openrouter:key-c"],
      }),
      store: authStore({
        "openrouter:key-a": { type: "api_key", provider: "openrouter", key: "sk-or-key-a" },
        "openrouter:key-b": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-actual-key-b",
        },
        "openrouter:key-c": { type: "api_key", provider: "openrouter", key: "sk-or-key-c" },
      }),
    });

    // Should select key-b (from per-entry apiKey reference), not key-a (first in auth.order)
    expect(resolved.apiKey).toBe("sk-or-actual-key-b");
    expect(resolved.profileId).toBe("openrouter:key-b");
    expect(resolved.source).toBe("profile:openrouter:key-b");
  });

  it("resolves profile reference even when provider sets auth: api-key explicitly (regression for clawsweeper P3)", async () => {
    // Before the fix the explicit `auth: "api-key"` early-return short-circuited
    // resolveUsableCustomProviderApiKey and sent "openrouter:key-b" as a literal bearer
    // before the profile-ref logic could run. Verify the profile-ref lookup wins.
    const resolved = await resolveApiKeyForProvider({
      provider: "openrouter-minimax",
      cfg: openRouterEntryConfig("openrouter:key-b", { auth: "api-key" }),
      store: apiKeyStore("openrouter:key-b", "openrouter", "sk-or-actual-key-b"),
    });

    expect(resolved.apiKey).toBe("sk-or-actual-key-b");
    expect(resolved.profileId).toBe("openrouter:key-b");
    expect(resolved.source).toBe("profile:openrouter:key-b");
  });

  it("applies model auth-mode guards to per-entry token profile references", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        modelApi: "openai-responses",
        cfg: openAiEntryConfig("openai:token", "openai-responses"),
        store: tokenStore("openai:token", "openai", "oauth-token"),
      }),
    ).rejects.toThrow(/requires an OpenAI API key profile/);
  });

  it("throws when matched profile is an OAuth credential routed to an api-key provider (clawsweeper P1)", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "openrouter-minimax",
        cfg: openRouterEntryConfig("google:oauth-a", { includeCanonical: false }),
        store: oauthStore("google:oauth-a", "google", {
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: 0,
        }),
      }),
    ).rejects.toThrow(
      /references a "oauth" credential for provider "google", which is not a bearer-style auth class/,
    );
  });

  it("throws when a bearer profile points at a different provider endpoint", async () => {
    await expect(
      resolveApiKeyForProvider({
        provider: "custom-proxy",
        cfg: openRouterEntryConfig("openrouter:key-b", {
          provider: "custom-proxy",
          baseUrl: "https://example.invalid/v1",
        }),
        store: apiKeyStore("openrouter:key-b", "openrouter", "sk-or-actual-key-b"),
      }),
    ).rejects.toThrow(/not compatible with this provider entry's auth binding/);
  });

  it("throws (does not fall through to literal bearer) when matched profile resolution fails (clawsweeper P2)", async () => {
    // Profile is matched on ID but its credential has no usable api key material
    // (no `key` and no `keyRef`). Pre-fix, this would fall through to the late
    // `resolveUsableCustomProviderApiKey` and send "openrouter:key-b" itself as the
    // literal bearer — the original #67423 failure mode. Verify it throws instead.
    await expect(
      resolveApiKeyForProvider({
        provider: "openrouter-minimax",
        cfg: openRouterEntryConfig("openrouter:key-b"),
        // no `key` and no `keyRef` -> resolveApiKeyForProfile returns null
        store: apiKeyStore("openrouter:key-b", "openrouter"),
      }),
    ).rejects.toThrow(/matched a stored profile but failed to resolve/);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
