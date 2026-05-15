import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { OAUTH_AGENT_ENV_KEYS, createExpiredOauthStore } from "./oauth-test-utils.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
type GetOAuthApiKey = typeof import("@earendil-works/pi-ai/oauth").getOAuthApiKey;

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn<GetOAuthApiKey>(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<() => OAuthCredential | null>(() => null),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }): Promise<OAuthCredential | undefined> => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("@earendil-works/pi-ai/oauth", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [
    { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
    { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
  ],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

afterAll(() => {
  vi.doUnmock("@earendil-works/pi-ai/oauth");
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
});

async function readPersistedStore(agentDir: string): Promise<AuthProfileStore> {
  return JSON.parse(
    await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
  ) as AuthProfileStore;
}

function mockRotatedOpenAICodexRefresh() {
  refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
    type: "oauth",
    provider: "openai-codex",
    access: "rotated-access-token",
    refresh: "rotated-refresh-token",
    expires: Date.now() + 86_400_000,
    accountId: "acct-rotated",
  });
}

function expectPersistedOpenAICodexProfileWithoutInlineTokens(
  credential: AuthProfileStore["profiles"][string],
  metadata: Record<string, unknown> = {},
): void {
  expect(credential?.type).toBe("oauth");
  expect(credential?.provider).toBe("openai-codex");
  for (const [key, value] of Object.entries(metadata)) {
    expect(credential?.[key as keyof typeof credential]).toBe(value);
  }
  expect(credential).not.toHaveProperty("access");
  expect(credential).not.toHaveProperty("refresh");
  expect(credential).not.toHaveProperty("idToken");
}

function resolveOpenAICodexProfile(params: { profileId: string; agentDir: string }) {
  return resolveApiKeyForProfile({
    store: ensureAuthProfileStore(params.agentDir),
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
}

function requireOAuthProfile(store: AuthProfileStore, profileId: string): OAuthCredential {
  const profile = store.profiles[profileId];
  expect(profile?.type).toBe("oauth");
  if (!profile || profile.type !== "oauth") {
    throw new Error(`expected OAuth profile ${profileId}`);
  }
  return profile;
}

function requireOAuthContext(context: unknown): OAuthCredential {
  expect(context && typeof context === "object").toBe(true);
  if (!context || typeof context !== "object") {
    throw new Error("expected OAuth credential context");
  }
  const credential = context as OAuthCredential;
  expect(credential.type).toBe("oauth");
  return credential;
}

describe("resolveApiKeyForProfile openai-codex refresh fallback", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("Failed to extract accountId from token");
    });
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    const caseRoot = path.join(tempRoot, `case-${++caseIndex}`);
    agentDir = path.join(caseRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = caseRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
  });

  afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to cached access token when openai-codex refresh fails on accountId extraction", async () => {
    const profileId = "openai-codex:default";
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => params?.context as never,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "cached-access-token", // pragma: allowlist secret
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes near-expiry openai-codex credentials before hard expiry", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "near-expiry-access-token",
            refresh: "near-expiry-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      },
      agentDir,
    );
    mockRotatedOpenAICodexRefresh();

    const result = await resolveOpenAICodexProfile({ profileId, agentDir });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("forces refresh for unexpired openai-codex credentials through the exported resolver", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "fresh-access-token",
            refresh: "fresh-refresh-token",
            expires: Date.now() + 86_400_000,
          },
        },
      },
      agentDir,
    );
    mockRotatedOpenAICodexRefresh();

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
      forceRefresh: true,
    });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("persists plugin-refreshed openai-codex metadata before returning", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "stale-access-token",
      }),
      agentDir,
    );
    mockRotatedOpenAICodexRefresh();

    const result = await resolveOpenAICodexProfile({ profileId, agentDir });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfileWithoutInlineTokens(persisted.profiles[profileId], {
      accountId: "acct-rotated",
    });
    expect(JSON.stringify(persisted)).not.toContain("rotated-access-token");
    expect(JSON.stringify(persisted)).not.toContain("rotated-refresh-token");
  });

  it("refreshes imported Codex credentials into the canonical auth store without writing back to .codex", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-access-token",
            refresh: "expired-refresh-token",
            expires: Date.now() - 60_000,
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "still-expired-cli-access-token",
      refresh: "still-expired-cli-refresh-token",
      expires: Date.now() - 30_000,
      accountId: "acct-cli",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "rotated-cli-access-token",
      refresh: "rotated-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-rotated",
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "rotated-cli-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfileWithoutInlineTokens(persisted.profiles[profileId], {
      accountId: "acct-rotated",
    });
    expect(JSON.stringify(persisted)).not.toContain("rotated-cli-access-token");
    expect(JSON.stringify(persisted)).not.toContain("rotated-cli-refresh-token");
    expect(persisted.profiles[profileId]).not.toHaveProperty("access");
  });

  it("ignores mismatched fresh Codex CLI credentials when canonical local auth is bound to another account", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "expired-local-access-token",
        refresh: "local-refresh-token",
        accountId: "acct-local",
      }),
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-external",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => {
        const context = requireOAuthContext(params?.context);
        expect(context.access).toBe("expired-local-access-token");
        expect(context.refresh).toBe("local-refresh-token");
        expect(context.accountId).toBe("acct-local");
        return {
          type: "oauth",
          provider: "openai-codex",
          access: "fresh-local-access-token",
          refresh: "fresh-local-refresh-token",
          expires: Date.now() + 86_400_000,
          accountId: "acct-local",
        };
      },
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).resolves.toEqual({
      apiKey: "fresh-local-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfileWithoutInlineTokens(persisted.profiles[profileId], {
      accountId: "acct-local",
    });
    expect(JSON.stringify(persisted)).not.toContain("fresh-local-access-token");
    expect(JSON.stringify(persisted)).not.toContain("fresh-local-refresh-token");
    const persistedProfile = requireOAuthProfile(persisted, profileId);
    expect(persistedProfile.accountId).toBe("acct-local");
    expect(persistedProfile).not.toHaveProperty("access");
    expect(persistedProfile).not.toHaveProperty("refresh");
  });

  it("keeps the canonical refresh token when imported Codex CLI state is expired", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-local-access-token",
            refresh: "stale-local-refresh-token",
            expires: Date.now() - 120_000,
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "newer-but-expired-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() - 30_000,
      accountId: "acct-cli",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => {
        const context = requireOAuthContext(params?.context);
        expect(context.access).toBe("expired-local-access-token");
        expect(context.refresh).toBe("stale-local-refresh-token");
        return {
          type: "oauth",
          provider: "openai-codex",
          access: "fresh-access-token",
          refresh: "fresh-refresh-token",
          expires: Date.now() + 86_400_000,
        };
      },
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).resolves.toEqual({
      apiKey: "fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfileWithoutInlineTokens(persisted.profiles[profileId]);
    expect(JSON.stringify(persisted)).not.toContain("fresh-access-token");
    expect(JSON.stringify(persisted)).not.toContain("fresh-refresh-token");
    expect(persisted.profiles[profileId]).not.toHaveProperty("refresh");
  });

  it("adopts fresher stored credentials after refresh_token_reused", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "reloaded-access-token",
              refresh: "reloaded-refresh-token",
              expires: Date.now() + 10 * 60_000,
            },
          },
        },
        agentDir,
      );
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).resolves.toEqual({
      apiKey: "reloaded-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("retries Codex refresh once after refresh_token_reused updates only the stored refresh token", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("refresh-token");
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "still-expired-access-token",
                refresh: "rotated-refresh-token",
                expires: Date.now() - 5_000,
              },
            },
          },
          agentDir,
        );
        throw new Error(
          '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
        );
      })
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("rotated-refresh-token");
        return {
          apiKey: "retried-access-token",
          newCredentials: {
            access: "retried-access-token",
            refresh: "retried-refresh-token",
            expires: Date.now() + 10 * 60_000,
          },
        };
      });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).resolves.toEqual({
      apiKey: "retried-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfileWithoutInlineTokens(persisted.profiles[profileId]);
    expect(JSON.stringify(persisted)).not.toContain("retried-access-token");
    expect(JSON.stringify(persisted)).not.toContain("retried-refresh-token");
  });

  it("keeps throwing for non-codex providers on the same refresh error", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
  });

  it("does not use fallback for unrelated openai-codex refresh errors", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });
});
