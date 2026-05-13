import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  refreshCodexAppServerAuthTokens,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerNativeHomeDir,
} from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";

const oauthMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { provider?: string; context: { refresh: string } }) => {
      const refreshed = await oauthMocks.refreshOpenAICodexToken(params.context.refresh);
      return refreshed
        ? {
            ...params.context,
            ...refreshed,
            type: "oauth",
            provider: "openai-codex",
          }
        : undefined;
    },
  ),
}));

vi.mock("@earendil-works/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
  loginOpenAICodex: vi.fn(),
  refreshOpenAICodexToken: oauthMocks.refreshOpenAICodexToken,
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProfile: async (
      params: Parameters<typeof actual.resolveApiKeyForProfile>[0],
    ) => {
      const credential = params.store.profiles[params.profileId];
      if (!credential) {
        return null;
      }
      if (credential.type === "api_key") {
        const apiKey =
          credential.key?.trim() ||
          (credential.keyRef?.source === "env" ? process.env[credential.keyRef.id]?.trim() : "");
        return apiKey ? { apiKey, provider: credential.provider } : null;
      }
      if (credential.type === "token") {
        const apiKey =
          credential.token?.trim() ||
          (credential.tokenRef?.source === "env"
            ? process.env[credential.tokenRef.id]?.trim()
            : "");
        return apiKey ? { apiKey, provider: credential.provider, email: credential.email } : null;
      }
      if (credential.type !== "oauth") {
        return null;
      }
      let oauthCredential = credential;
      if ((oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
          provider: oauthCredential.provider,
          context: oauthCredential,
        });
        if (refreshed?.access) {
          oauthCredential = refreshed as typeof oauthCredential;
          params.store.profiles[params.profileId] = oauthCredential;
          if (params.agentDir || process.env.OPENCLAW_STATE_DIR) {
            actual.saveAuthProfileStore(params.store, params.agentDir);
          }
        }
      }
      const formatted = await providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin({
        provider: oauthCredential.provider,
        context: oauthCredential,
      });
      const apiKey =
        typeof formatted === "string" && formatted ? formatted : oauthCredential.access;
      return apiKey
        ? { apiKey, provider: oauthCredential.provider, email: oauthCredential.email }
        : null;
    },
    refreshOAuthCredentialForRuntime: async (
      params: Parameters<typeof actual.refreshOAuthCredentialForRuntime>[0],
    ) => {
      const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
        provider: params.credential.provider,
        context: params.credential,
      });
      return refreshed
        ? {
            ...params.credential,
            ...refreshed,
            type: "oauth" as const,
          }
        : null;
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  oauthMocks.refreshOpenAICodexToken.mockReset();
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

type AuthProfileStore = ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
type AuthProfileCredential = AuthProfileStore["profiles"][string];

function expectOAuthProfile(
  profile: AuthProfileCredential | undefined,
): Extract<AuthProfileCredential, { type: "oauth" }> {
  if (!profile || profile.type !== "oauth") {
    throw new Error("Expected OAuth auth profile");
  }
  return profile;
}

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "account-cli",
      },
    })}\n`,
  );
}

describe("bridgeCodexAppServerStartOptions", () => {
  it("sets agent-owned CODEX_HOME and HOME for local app-server launches", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions();
    try {
      const codexHome = resolveCodexAppServerHomeDir(agentDir);
      const nativeHome = resolveCodexAppServerNativeHomeDir(agentDir);

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          CODEX_HOME: codexHome,
          HOME: nativeHome,
        },
      });
      await expect(fs.access(codexHome)).resolves.toBeUndefined();
      await expect(fs.access(nativeHome)).resolves.toBeUndefined();
      expect(startOptions.env).toBeUndefined();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit CODEX_HOME and HOME overrides", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const codexHome = path.join(agentDir, "custom-codex-home");
    const nativeHome = path.join(agentDir, "custom-native-home");
    const startOptions = createStartOptions({
      env: { CODEX_HOME: codexHome, HOME: nativeHome, EXISTING: "1" },
      clearEnv: ["CODEX_HOME", "HOME", "FOO"],
    });
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          CODEX_HOME: codexHome,
          HOME: nativeHome,
          EXISTING: "1",
        },
        clearEnv: ["FOO"],
      });
      await expect(fs.access(codexHome)).resolves.toBeUndefined();
      await expect(fs.access(nativeHome)).resolves.toBeUndefined();
      expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears inherited API-key env vars when the default Codex profile is subscription auth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      env: { EXISTING: "1" },
      clearEnv: ["FOO"],
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:default",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          EXISTING: "1",
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
          HOME: resolveCodexAppServerNativeHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
      expect(startOptions.clearEnv).toEqual(["FOO"]);
      await expectPathMissing(path.join(agentDir, "harness-auth"));
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex OAuth profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
          HOME: resolveCodexAppServerNativeHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex token profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "openai-codex",
          token: "access-token",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
          HOME: resolveCodexAppServerNativeHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an inherited OpenAI API key for an explicit Codex api-key profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          key: "explicit-api-key",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
          HOME: resolveCodexAppServerNativeHomeDir(agentDir),
        },
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not clear process environment for websocket app-server connections", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      transport: "websocket",
      url: "ws://127.0.0.1:1455",
      clearEnv: ["FOO"],
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toBe(startOptions);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints resolved API-key auth-profile secrets without exposing them", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          key: "first-secret-key",
        },
      });
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          key: "second-secret-key",
        },
      });
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(first).toMatch(/^openai-codex:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^openai-codex:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-secret-key");
      expect(second).not.toContain("second-secret-key");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints API-key auth-profile secret refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          keyRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TEST_KEY" },
        },
      });
      vi.stubEnv("OPENAI_CODEX_TEST_KEY", "first-ref-secret");
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      vi.stubEnv("OPENAI_CODEX_TEST_KEY", "second-ref-secret");
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(first).toMatch(/^openai-codex:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^openai-codex:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-ref-secret");
      expect(second).not.toContain("second-ref-secret");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints token auth-profile secret refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "openai-codex",
          tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TEST_TOKEN" },
          email: "codex@example.test",
        },
      });
      vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "first-ref-token");
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "second-ref-token");
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(first).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-ref-token");
      expect(second).not.toContain("second-ref-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex OAuth profile through app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves native app-server auth untouched when auth bridging is disabled", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ requiresOpenaiAuth: true }));
    try {
      vi.stubEnv("OPENAI_API_KEY", "env-api-key");

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: null,
        startOptions: createStartOptions(),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies a normal OpenAI API-key profile as a Codex app-server backup", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-backup",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:default",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "sk-openai-backup",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies the default OpenAI Codex OAuth profile when no profile id is explicit", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:default",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "default-access-token",
          refresh: "default-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-default",
          email: "codex-default@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "default-access-token",
        chatgptAccountId: "account-default",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies native Codex CLI OAuth when no OpenClaw auth profile exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "cli-access-token",
        chatgptAccountId: "account-cli",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles).not.toHaveProperty(
        "openai-codex:default",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("answers refresh from native Codex CLI OAuth without persisting an OpenClaw profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const authProfileStorePath = path.join(agentDir, "auth-profiles.json");
    vi.stubEnv("CODEX_HOME", codexHome);
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-cli-refreshed",
    });
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(refreshCodexAppServerAuthTokens({ agentDir })).resolves.toEqual({
        accessToken: "fresh-cli-access-token",
        chatgptAccountId: "account-cli-refreshed",
        chatgptPlanType: null,
      });

      await expectPathMissing(authProfileStorePath);
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("cli-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses native Codex CLI OAuth when deriving cache keys from a supplied base store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(
        resolveCodexAppServerAuthAccountCacheKey({
          agentDir,
          authProfileStore: { version: 1, profiles: {} },
        }),
      ).resolves.toBe("account-cli");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors config auth order when selecting an implicit Codex profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:default",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "default-access-token",
          refresh: "default-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-default",
        },
      });
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "work-access-token",
          refresh: "work-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-work",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        config: {
          auth: {
            order: {
              "openai-codex": ["openai-codex:work", "openai-codex:default"],
            },
          },
        },
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "work-access-token",
        chatgptAccountId: "account-work",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired OpenAI Codex OAuth profile before app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-456",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "expired-access-token",
          refresh: "refresh-token",
          expires: Date.now() - 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "fresh-access-token",
        chatgptAccountId: "account-456",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex api-key profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    vi.stubEnv("OPENAI_CODEX_API_KEY", "ref-backed-api-key");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          keyRef: { source: "env", provider: "default", id: "OPENAI_CODEX_API_KEY" },
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "ref-backed-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported Codex auth profile credential types before OAuth refresh", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:aws",
        credential: {
          type: "aws-sdk",
          provider: "openai-codex",
        } as never,
      });

      await expect(
        applyCodexAppServerAuthProfile({
          client: { request } as never,
          agentDir,
          authProfileId: "openai-codex:aws",
        }),
      ).rejects.toThrow(
        'Codex app-server auth profile "openai-codex:aws" does not contain usable credentials.',
      );
      expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to CODEX_API_KEY when no auth profile and no Codex account is available", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions({
          env: { CODEX_API_KEY: "configured-codex-api-key" },
        }),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "configured-codex-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to OPENAI_API_KEY when CODEX_API_KEY is not set", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "openai-env-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an existing app-server ChatGPT account over env API-key fallback", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", email: "codex@example.test", planType: "plus" },
          requiresOpenaiAuth: true,
        };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("skips env API-key fallback when app-server does not require OpenAI auth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: false };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("honors clearEnv before env API-key fallback", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions({
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        }),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not send env API-key fallback to websocket app-server connections", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        startOptions: createStartOptions({
          transport: "websocket",
          url: "ws://127.0.0.1:1455",
        }),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex token profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    vi.stubEnv("OPENAI_CODEX_TOKEN", "ref-backed-access-token");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "openai-codex",
          tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TOKEN" },
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "ref-backed-access-token",
        chatgptAccountId: "codex@example.test",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("accepts a legacy Codex auth-provider alias for app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "token",
          provider: "codex-cli",
          token: "legacy-access-token",
          email: "legacy-codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "legacy-access-token",
        chatgptAccountId: "legacy-codex@example.test",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("answers app-server ChatGPT token refresh requests from the bound profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-access-token",
      refresh: "refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-789",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "stale-access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-access-token",
        chatgptAccountId: "account-789",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes inherited main Codex OAuth without cloning it into the child store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const stateDir = path.join(root, "state");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = path.join(childAgentDir, "auth-profiles.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-main-refreshed",
    });
    try {
      upsertAuthProfile({
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "main-current-access-token",
          refresh: "main-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-main",
          email: "main-codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir: childAgentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "main-refreshed-access-token",
        chatgptAccountId: "account-main-refreshed",
        chatgptPlanType: null,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("main-refresh-token");
      await expectPathMissing(childAuthPath);
      const mainProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime().profiles["openai-codex:work"],
      );
      expect(mainProfile?.provider).toBe("openai-codex");
      expect(mainProfile?.access).toBe("main-refreshed-access-token");
      expect(mainProfile?.refresh).toBe("main-refreshed-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("force-refreshes the owner credential instead of a stale child OAuth clone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const stateDir = path.join(root, "state");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = path.join(childAgentDir, "auth-profiles.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-main-refreshed",
    });
    try {
      upsertAuthProfile({
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "main-current-access-token",
          refresh: "main-owner-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-main",
          email: "main-codex@example.test",
        },
      });
      await fs.mkdir(childAgentDir, { recursive: true });
      await fs.writeFile(
        childAuthPath,
        JSON.stringify({
          version: 1,
          profiles: {
            "openai-codex:work": {
              type: "oauth",
              provider: "openai-codex",
              access: "child-stale-access-token",
              refresh: "child-stale-refresh-token",
              expires: Date.now() - 60_000,
              accountId: "account-main",
              email: "main-codex@example.test",
            },
          },
        }),
      );

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir: childAgentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "main-refreshed-access-token",
        chatgptAccountId: "account-main-refreshed",
        chatgptPlanType: null,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("main-owner-refresh-token");
      const mainProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime().profiles["openai-codex:work"],
      );
      expect(mainProfile?.provider).toBe("openai-codex");
      expect(mainProfile?.access).toBe("main-refreshed-access-token");
      expect(mainProfile?.refresh).toBe("main-refreshed-refresh-token");
      const childProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime(childAgentDir).profiles["openai-codex:work"],
      );
      expect(childProfile?.access).toBe("child-stale-access-token");
      expect(childProfile?.refresh).toBe("child-stale-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a refreshed Codex OAuth credential when the stored provider is a legacy alias", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-alias-access-token",
      refresh: "refreshed-alias-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-alias",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "codex-cli",
          access: "stale-alias-access-token",
          refresh: "alias-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-legacy",
          email: "legacy-codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai-codex:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-alias-access-token",
        chatgptAccountId: "account-alias",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("alias-refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves a stored ChatGPT plan type when building token login params", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:work",
        credential: {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
          chatgptPlanType: "pro",
        } as never,
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai-codex:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: "pro",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
