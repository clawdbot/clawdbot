import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

vi.mock("../agents/auth-profiles.js", () => {
  const normalizeProvider = (provider?: string | null): string =>
    (provider ?? "")
      .trim()
      .toLowerCase()
      .replace(/^z-ai$/, "zai");
  const dedupeProfileIds = (profileIds: string[]): string[] => [...new Set(profileIds)];
  const listProfilesForProvider = (
    store: { profiles?: Record<string, { provider?: string } | undefined> },
    provider: string,
  ): string[] =>
    Object.entries(store.profiles ?? {})
      .filter(([, profile]) => normalizeProvider(profile?.provider) === normalizeProvider(provider))
      .map(([profileId]) => profileId);
  const readStore = (agentDir?: string) => {
    if (!agentDir) {
      return { version: 1, profiles: {} };
    }
    const authPath = path.join(agentDir, "auth-profiles.json");
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(authPath, "utf8")) as {
        version?: number;
        profiles?: Record<string, unknown>;
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, unknown>;
      };
      return {
        version: parsed.version ?? 1,
        profiles: parsed.profiles ?? {},
        ...(parsed.order ? { order: parsed.order } : {}),
        ...(parsed.lastGood ? { lastGood: parsed.lastGood } : {}),
        ...(parsed.usageStats ? { usageStats: parsed.usageStats } : {}),
      };
    } catch {
      return { version: 1, profiles: {} };
    }
  };

  const resolveAuthProfileOrder = (params: {
    cfg?: { auth?: { profiles?: Record<string, { provider?: string } | undefined> } };
    store: {
      profiles: Record<string, { provider?: string } | undefined>;
      order?: Record<string, string[]>;
    };
    provider: string;
  }): string[] => {
    const provider = normalizeProvider(params.provider);
    const configured = Object.entries(params.cfg?.auth?.profiles ?? {})
      .filter(([, profile]) => normalizeProvider(profile?.provider) === provider)
      .map(([profileId]) => profileId);
    if (configured.length > 0) {
      return dedupeProfileIds(configured);
    }
    const ordered = params.store.order?.[params.provider] ?? params.store.order?.[provider];
    if (ordered?.length) {
      return dedupeProfileIds(ordered);
    }
    return dedupeProfileIds(listProfilesForProvider(params.store, provider));
  };

  const resolveApiKeyForProfile = async (params: {
    store: {
      profiles: Record<
        string,
        | {
            type?: string;
            provider?: string;
            key?: string;
            token?: string;
            accessToken?: string;
            email?: string;
            expires?: number;
          }
        | undefined
      >;
    };
    profileId: string;
  }): Promise<{ apiKey: string; provider: string; email?: string } | null> => {
    const cred = params.store.profiles[params.profileId];
    if (!cred) {
      return null;
    }
    const profileProvider = normalizeProvider(params.profileId.split(":")[0] ?? "");
    const credentialProvider = normalizeProvider(cred.provider);
    if (profileProvider && credentialProvider && profileProvider !== credentialProvider) {
      return null;
    }
    if (cred.type === "api_key") {
      return cred.key ? { apiKey: cred.key, provider: cred.provider ?? profileProvider } : null;
    }
    if (cred.type === "token") {
      if (typeof cred.expires === "number" && cred.expires <= Date.now()) {
        return null;
      }
      return cred.token
        ? { apiKey: cred.token, provider: cred.provider ?? profileProvider, email: cred.email }
        : null;
    }
    if (cred.type === "oauth") {
      if (typeof cred.expires === "number" && cred.expires <= Date.now()) {
        return null;
      }
      const token = cred.accessToken ?? cred.token;
      return token
        ? { apiKey: token, provider: cred.provider ?? profileProvider, email: cred.email }
        : null;
    }
    return null;
  };

  return {
    clearRuntimeAuthProfileStoreSnapshots: () => {},
    ensureAuthProfileStore: (agentDir?: string) => readStore(agentDir),
    hasAnyAuthProfileStoreSource: (agentDir?: string) =>
      Boolean(agentDir && nodeFs.existsSync(path.join(agentDir, "auth-profiles.json"))),
    dedupeProfileIds,
    listProfilesForProvider,
    resolveApiKeyForProfile,
    resolveAuthProfileOrder,
  };
});

const providerRuntimeMocks = vi.hoisted(() => ({
  providerRuntimeMock: {
    augmentModelCatalogWithProviderPlugins: vi.fn((catalog: unknown) => catalog),
    buildProviderAuthDoctorHintWithPlugin: vi.fn(() => undefined),
    buildProviderMissingAuthMessageWithPlugin: vi.fn(() => undefined),
    buildProviderUnknownModelHintWithPlugin: vi.fn(() => undefined),
    clearProviderRuntimeHookCache: vi.fn(() => {}),
    createProviderEmbeddingProvider: vi.fn(() => undefined),
    formatProviderAuthProfileApiKeyWithPlugin: vi.fn(() => undefined),
    normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
    prepareProviderDynamicModel: vi.fn(async () => {}),
    prepareProviderExtraParams: vi.fn(() => undefined),
    prepareProviderRuntimeAuth: vi.fn(async () => undefined),
    refreshProviderOAuthCredentialWithPlugin: vi.fn(async () => undefined),
    resetProviderRuntimeHookCacheForTest: vi.fn(() => {}),
    resolveProviderBinaryThinking: vi.fn(() => undefined),
    resolveProviderBuiltInModelSuppression: vi.fn(() => undefined),
    resolveProviderCacheTtlEligibility: vi.fn(() => undefined),
    resolveProviderCapabilitiesWithPlugin: vi.fn(() => undefined),
    resolveProviderDefaultThinkingLevel: vi.fn(() => undefined),
    resolveProviderModernModelRef: vi.fn(() => undefined),
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    resolveProviderStreamFn: vi.fn(() => undefined),
    resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
    resolveProviderUsageAuthWithPlugin: vi.fn(async (params) => {
      const resolveToken = (options?: {
        providerIds?: string[];
        envDirect?: Array<string | undefined>;
      }) => params.context.resolveApiKeyFromConfigAndStore(options);
      const resolveLegacyZaiToken = (): string | null => {
        const home = params.context.env?.HOME ?? params.context.env?.USERPROFILE;
        if (!home) {
          return null;
        }
        try {
          const parsed = JSON.parse(
            nodeFs.readFileSync(path.join(home, ".pi", "agent", "auth.json"), "utf8"),
          ) as {
            "z-ai"?: { access?: string };
          };
          return parsed["z-ai"]?.access ?? null;
        } catch {
          return null;
        }
      };

      if (params.provider === "zai") {
        const token = resolveToken({
          providerIds: ["zai", "z-ai"],
          envDirect: [params.context.env?.ZAI_API_KEY, params.context.env?.Z_AI_API_KEY],
        });
        return token
          ? { token }
          : resolveLegacyZaiToken()
            ? { token: resolveLegacyZaiToken()! }
            : null;
      }

      if (params.provider === "minimax") {
        const token = resolveToken({
          providerIds: ["minimax"],
          envDirect: [
            params.context.env?.MINIMAX_CODE_PLAN_KEY,
            params.context.env?.MINIMAX_CODING_API_KEY,
            params.context.env?.MINIMAX_API_KEY,
          ],
        });
        return token ? { token } : null;
      }

      if (params.provider === "xiaomi") {
        const token = resolveToken({
          providerIds: ["xiaomi"],
          envDirect: [params.context.env?.XIAOMI_API_KEY],
        });
        return token ? { token } : null;
      }

      if (params.provider === "google-gemini-cli") {
        const resolved = await params.context.resolveOAuthToken({
          provider: "google-gemini-cli",
        });
        if (!resolved?.token) {
          return null;
        }
        try {
          const parsed = JSON.parse(resolved.token) as { token?: string };
          const token = parsed.token ?? resolved.token;
          return resolved.accountId ? { token, accountId: resolved.accountId } : { token };
        } catch {
          return resolved.accountId
            ? { token: resolved.token, accountId: resolved.accountId }
            : { token: resolved.token };
        }
      }

      return null;
    }),
    resolveProviderXHighThinking: vi.fn(() => undefined),
    runProviderDynamicModel: vi.fn(() => undefined),
    wrapProviderStreamFn: vi.fn(() => undefined),
  },
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    ...providerRuntimeMocks.providerRuntimeMock,
  };
});

vi.mock("../plugins/provider-runtime.ts", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.ts")>(
    "../plugins/provider-runtime.ts",
  );
  return {
    ...actual,
    ...providerRuntimeMocks.providerRuntimeMock,
  };
});

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../agents/auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-provider-auth-suite-" });

describe("resolveProviderAuths key normalization", () => {
  const EMPTY_PROVIDER_ENV = {
    ZAI_API_KEY: undefined,
    Z_AI_API_KEY: undefined,
    MINIMAX_API_KEY: undefined,
    MINIMAX_CODE_PLAN_KEY: undefined,
    MINIMAX_CODING_API_KEY: undefined,
    XIAOMI_API_KEY: undefined,
  } satisfies Record<string, string | undefined>;

  beforeAll(async () => {
    await suiteRootTracker.setup();
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
    ({ clearRuntimeAuthProfileStoreSnapshots } = await import("../agents/auth-profiles.js"));
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.restoreAllMocks();
  });

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const base = await suiteRootTracker.make("case");
    const stateDir = path.join(base, ".openclaw");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    nodeFs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    nodeFs.mkdirSync(agentDir, { recursive: true });
    nodeFs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ version: 1, profiles: {} }, null, 2)}\n`,
      "utf8",
    );
    return await fn(base);
  }

  function agentDirForHome(home: string): string {
    return path.join(home, ".openclaw", "agents", "main", "agent");
  }

  function buildSuiteEnv(
    home: string,
    env: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv {
    const suiteEnv: NodeJS.ProcessEnv = {
      ...EMPTY_PROVIDER_ENV,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      ...env,
    };
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      suiteEnv.HOMEDRIVE = match[1];
      suiteEnv.HOMEPATH = match[2] || "\\";
    }
    return suiteEnv;
  }

  async function writeAuthProfiles(home: string, profiles: Record<string, unknown>) {
    const agentDir = agentDirForHome(home);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
      "utf8",
    );
  }

  async function writeConfig(home: string, config: Record<string, unknown>) {
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  async function writeProfileOrder(home: string, provider: string, profileIds: string[]) {
    const agentDir = agentDirForHome(home);
    const parsed = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as Record<string, unknown>;
    const order = (parsed.order && typeof parsed.order === "object" ? parsed.order : {}) as Record<
      string,
      unknown
    >;
    order[provider] = profileIds;
    parsed.order = order;
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
  }

  async function writeLegacyPiAuth(home: string, raw: string) {
    const legacyDir = path.join(home, ".pi", "agent");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "auth.json"), raw, "utf8");
  }

  function createTestModelDefinition(): ModelDefinitionConfig {
    return {
      id: "test-model",
      name: "Test Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 256,
    };
  }

  async function resolveMinimaxAuthFromConfiguredKey(apiKey: string) {
    return await withSuiteHome(async (home) => {
      const config = {
        models: {
          providers: {
            minimax: {
              baseUrl: "https://api.minimaxi.com",
              models: [createTestModelDefinition()],
              apiKey,
            },
          },
        },
      } satisfies OpenClawConfig;
      await writeConfig(home, config);

      return await resolveProviderAuths({
        providers: ["minimax"],
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
    });
  }

  async function expectResolvedAuthsFromSuiteHome(params: {
    providers: Parameters<typeof resolveProviderAuths>[0]["providers"];
    expected: Awaited<ReturnType<typeof resolveProviderAuths>>;
    env?: Record<string, string | undefined>;
    config?: OpenClawConfig;
    setup?: (home: string) => Promise<void>;
  }) {
    await withSuiteHome(async (home) => {
      if (params.setup) {
        await params.setup(home);
      }
      const config = params.config ?? {};
      const auths = await resolveProviderAuths({
        providers: params.providers,
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home, params.env),
      });
      expect(auths).toEqual(params.expected);
    });
  }

  it("strips embedded CR/LF from env keys", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      env: {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
      },
      expected: [
        { provider: "zai", token: "zai-key" },
        { provider: "minimax", token: "minimax-key" },
        { provider: "xiaomi", token: "xiaomi-key" },
      ],
    });
  }, 300_000);

  it("accepts z-ai env alias and normalizes embedded CR/LF", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        Z_AI_API_KEY: "zai-\r\nkey",
      },
      expected: [{ provider: "zai", token: "zai-key" }],
    });
  });

  it("prefers ZAI_API_KEY over the z-ai alias when both are set", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      env: {
        ZAI_API_KEY: "direct-zai-key",
        Z_AI_API_KEY: "alias-zai-key",
      },
      expected: [{ provider: "zai", token: "direct-zai-key" }],
    });
  });

  it("prefers MINIMAX_CODE_PLAN_KEY over MINIMAX_API_KEY", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax"],
      env: {
        MINIMAX_CODE_PLAN_KEY: "code-plan-key",
        MINIMAX_API_KEY: "api-key",
      },
      expected: [{ provider: "minimax", token: "code-plan-key" }],
    });
  });

  it("accepts MINIMAX_CODING_API_KEY as a coding-plan alias", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax"],
      env: {
        MINIMAX_CODING_API_KEY: "coding-api-key",
      },
      expected: [{ provider: "minimax", token: "coding-api-key" }],
    });
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax", "xiaomi"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
          "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
        });
      },
      expected: [
        { provider: "minimax", token: "mini-max" },
        { provider: "xiaomi", token: "xiao-mi" },
      ],
    });
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("falls back to legacy .pi auth file for zai keys even after os.homedir() is primed", async () => {
    // Prime os.homedir() to simulate long-lived workers that may have touched it before HOME changes.
    os.homedir();
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeLegacyPiAuth(
          home,
          `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
        );
      },
      expected: [{ provider: "zai", token: "legacy-zai-key" }],
    });
  });

  it.each([
    {
      name: "extracts google oauth token from JSON payload in token profiles",
      token: '{"token":"google-oauth-token"}',
      expectedToken: "google-oauth-token",
    },
    {
      name: "keeps raw google token when token payload is not JSON",
      token: "plain-google-token",
      expectedToken: "plain-google-token",
    },
  ])("$name", async ({ token, expectedToken }) => {
    const googleGeminiCliUsageProvider = "google-gemini-cli" as unknown as Parameters<
      typeof resolveProviderAuths
    >[0]["providers"][number];
    await expectResolvedAuthsFromSuiteHome({
      providers: [googleGeminiCliUsageProvider],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "google-gemini-cli:default": {
            type: "token",
            provider: "google-gemini-cli",
            token,
          },
        });
      },
      expected: [{ provider: googleGeminiCliUsageProvider, token: expectedToken }],
    });
  });

  it("uses config api keys when env and profiles are missing", async () => {
    const config = {
      models: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai",
            models: [createTestModelDefinition()],
            apiKey: "cfg-zai-key", // pragma: allowlist secret
          },
          minimax: {
            baseUrl: "https://api.minimaxi.com",
            models: [createTestModelDefinition()],
            apiKey: "cfg-minimax-key", // pragma: allowlist secret
          },
          xiaomi: {
            baseUrl: "https://api.xiaomi.example",
            models: [createTestModelDefinition()],
            apiKey: "cfg-xiaomi-key", // pragma: allowlist secret
          },
        },
      },
    } satisfies OpenClawConfig;
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      setup: async (home) => {
        await writeConfig(home, config);
      },
      config,
      expected: [
        { provider: "zai", token: "cfg-zai-key" },
        { provider: "minimax", token: "cfg-minimax-key" },
        { provider: "xiaomi", token: "cfg-xiaomi-key" },
      ],
    });
  });

  it("returns no auth when providers have no configured credentials", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      expected: [],
    });
  });

  it("uses zai api_key auth profiles when env and config are missing", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "zai:default": { type: "api_key", provider: "zai", key: "profile-zai-key" },
        });
      },
      expected: [{ provider: "zai", token: "profile-zai-key" }],
    });
  });

  it("ignores invalid legacy z-ai auth files", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeLegacyPiAuth(home, "{not-json");
      },
      expected: [],
    });
  });

  it("discovers oauth provider from config but skips mismatched profile providers", async () => {
    await withSuiteHome(async (home) => {
      const config = {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
      } satisfies OpenClawConfig;
      await writeConfig(home, config);
      await writeAuthProfiles(home, {
        "anthropic:default": {
          type: "token",
          provider: "zai",
          token: "mismatched-provider-token",
        },
      });

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config,
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([]);
    });
  });

  it("skips providers without oauth-compatible profiles", async () => {
    await withSuiteHome(async (home) => {
      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([]);
    });
  });

  it("skips oauth profiles that resolve without an api key and uses later profiles", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "anthropic:empty": {
          type: "token",
          provider: "anthropic",
          token: "expired-token",
          expires: Date.now() - 60_000,
        },
        "anthropic:valid": { type: "token", provider: "anthropic", token: "anthropic-token" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:empty", "anthropic:valid"]);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "anthropic-token" }]);
    });
  });

  it("skips api_key entries in oauth token resolution order", async () => {
    await withSuiteHome(async (home) => {
      await writeAuthProfiles(home, {
        "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key-1" },
        "anthropic:token": { type: "token", provider: "anthropic", token: "token-1" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:api", "anthropic:token"]);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        agentDir: agentDirForHome(home),
        config: {},
        env: buildSuiteEnv(home),
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "token-1" }]);
    });
  });

  it("ignores marker-backed config keys for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey(NON_ENV_SECRETREF_MARKER);
    expect(auths).toEqual([]);
  });

  it("keeps all-caps plaintext config keys eligible for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey("ALLCAPS_SAMPLE");
    expect(auths).toEqual([{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]);
  });
});
