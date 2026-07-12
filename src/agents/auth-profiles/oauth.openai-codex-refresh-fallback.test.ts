/**
 * Tests OpenAI/Codex OAuth refresh fallback behavior.
 * Covers CLI bootstrap and ensures refresh failures fail closed instead of
 * being masked by external CLI credentials.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, resetFileLockStateForTest } from "../../infra/file-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { buildRefreshContentionError } from "./oauth-refresh-lock-errors.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createExpiredOauthStore,
  readAuthProfileStoreForTest,
} from "./oauth-test-utils.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resolveApiKeyForProvider: typeof import("../model-auth.js").resolveApiKeyForProvider;
let hasAvailableAuthForProvider: typeof import("../model-auth.js").hasAvailableAuthForProvider;
let markAuthProfileSuccess: typeof import("./profiles.js").markAuthProfileSuccess;
type GetOAuthApiKey = typeof import("../../llm/oauth.js").getOAuthApiKey;

const { getOAuthApiKeyMock } = vi.hoisted(() => {
  vi.resetModules();
  return {
    getOAuthApiKeyMock: vi.fn<GetOAuthApiKey>(async () => {
      throw new Error("Failed to extract accountId from token");
    }),
  };
});

const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<(_options?: unknown) => OAuthCredential | null>(
    () => null,
  ),
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

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [
    { id: "openai", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
    { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
  ],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveExternalAuthProfilesWithPlugins: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => false,
}));

afterAll(() => {
  vi.doUnmock("../../llm/oauth.js");
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
  vi.resetModules();
});

async function readPersistedStore(agentDir: string): Promise<AuthProfileStore> {
  return readAuthProfileStoreForTest(agentDir);
}

function mockRotatedOpenAICodexRefresh() {
  refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
    type: "oauth",
    provider: "openai",
    access: "rotated-access-token",
    refresh: "rotated-refresh-token",
    expires: Date.now() + 86_400_000,
    accountId: "acct-rotated",
  });
}

function expectPersistedOpenAICodexProfile(
  credential: AuthProfileStore["profiles"][string],
  metadata: Record<string, unknown> = {},
): void {
  expect(credential?.type).toBe("oauth");
  expect(credential?.provider).toBe("openai");
  for (const [key, value] of Object.entries(metadata)) {
    expect(credential?.[key as keyof typeof credential]).toBe(value);
  }
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

describe("resolveApiKeyForProfile openai refresh fallback", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    ({ resolveApiKeyForProfile } = await import("./oauth.js"));
    ({ hasAvailableAuthForProvider, resolveApiKeyForProvider } = await import("../model-auth.js"));
    ({ markAuthProfileSuccess } = await import("./profiles.js"));
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
    setTestEnvValue("OPENCLAW_STATE_DIR", caseRoot);
    setTestEnvValue("OPENCLAW_AGENT_DIR", agentDir);
  });

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    envSnapshot.restore();
  });

  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("fails closed instead of using matching cached Codex CLI credentials when openai refresh fails", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        accountId: "acct-cached",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "cached-access-token",
      refresh: "cached-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-cached",
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces refresh contention once without local lock details", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider: "openai" }), agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const lockPath = path.join(agentDir, "oauth-refresh.lock");
    const lockCause = Object.assign(new Error(`file lock timeout for ${lockPath}`), {
      code: FILE_LOCK_TIMEOUT_ERROR_CODE,
      lockPath,
    });
    refreshProviderOAuthCredentialWithPluginMock.mockRejectedValueOnce(
      buildRefreshContentionError({ provider: "openai", profileId, cause: lockCause }),
    );

    const failure = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
      forceRefresh: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(failure).toMatchObject({
      provider: "openai",
      profileId,
      reason: null,
      cause: { code: "refresh_contention", lockPath },
    });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message.match(/OAuth token refresh failed/g)).toHaveLength(1);
    expect(message.match(/OAuth refresh failed \(refresh_contention\)/g)).toHaveLength(1);
    expect(message).not.toContain(lockPath);
    expect(message).not.toContain("file lock timeout");
  });

  it("does not fill an explicit empty default profile beside managed OpenAI OAuth", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "",
            refresh: "",
            expires: 0,
          },
          "openai:user@example.com": {
            type: "oauth",
            provider: "openai",
            access: "managed-access-token",
            refresh: "managed-refresh-token",
            expires: Date.now() - 60_000,
            accountId: "acct-managed",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-codex",
    });

    await expect(resolveOpenAICodexProfile({ profileId, agentDir })).resolves.toBeNull();
    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("refreshes near-expiry openai credentials before hard expiry", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
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
      provider: "openai",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("forces refresh for unexpired openai credentials through the exported resolver", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
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
      provider: "openai",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("persists plugin-refreshed openai credentials before returning", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        access: "stale-access-token",
      }),
      agentDir,
    );
    mockRotatedOpenAICodexRefresh();

    const result = await resolveOpenAICodexProfile({ profileId, agentDir });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      provider: "openai",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(persisted.profiles[profileId], "persisted.profiles[profileId] test invariant"),
      {
        access: "rotated-access-token",
        refresh: "rotated-refresh-token",
        accountId: "acct-rotated",
      },
    );
  });

  it("refreshes imported Codex credentials into the canonical auth store without writing back to .codex", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
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
      provider: "openai",
      access: "still-expired-cli-access-token",
      refresh: "still-expired-cli-refresh-token",
      expires: Date.now() - 30_000,
      accountId: "acct-cli",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      type: "oauth",
      provider: "openai",
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
      provider: "openai",
      email: undefined,
    });
    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(persisted.profiles[profileId], "persisted.profiles[profileId] test invariant"),
      {
        access: "rotated-cli-access-token",
        refresh: "rotated-cli-refresh-token",
        accountId: "acct-rotated",
      },
    );
  });

  it("ignores mismatched fresh Codex CLI credentials when canonical local auth is bound to another account", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        access: "expired-local-access-token",
        refresh: "local-refresh-token",
        accountId: "acct-local",
      }),
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValueOnce({
      type: "oauth",
      provider: "openai",
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
          provider: "openai",
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
      provider: "openai",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(persisted.profiles[profileId], "persisted.profiles[profileId] test invariant"),
      {
        access: "fresh-local-access-token",
        refresh: "fresh-local-refresh-token",
        accountId: "acct-local",
      },
    );
    const persistedProfile = requireOAuthProfile(persisted, profileId);
    expect(persistedProfile.accountId).toBe("acct-local");
  });

  it("keeps the canonical refresh token when imported Codex CLI state is expired", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
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
      provider: "openai",
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
          provider: "openai",
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
      provider: "openai",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(persisted.profiles[profileId], "persisted.profiles[profileId] test invariant"),
      {
        access: "fresh-access-token",
        refresh: "fresh-refresh-token",
      },
    );
  });

  it("does not use same-account Codex CLI credentials after forced local refresh fails", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "local-access-token",
            refresh: "local-refresh-token",
            expires: Date.now() + 86_400_000,
            accountId: "acct-shared",
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);

    const persisted = await readPersistedStore(agentDir);
    const persistedProfile = requireOAuthProfile(persisted, profileId);
    expect(persistedProfile.accountId).toBe("acct-shared");
    expect(persistedProfile.access).toBe("local-access-token");
    expect(persistedProfile.refresh).toBe("local-refresh-token");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-access-token");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-refresh-token");
  });

  it("does not use same-account Codex CLI credentials when default-agent store omits agentDir", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "local-access-token",
            refresh: "local-refresh-token",
            expires: Date.now() + 86_400_000,
            accountId: "acct-shared",
            email: "user@example.com",
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        store: ensureAuthProfileStore(agentDir),
        profileId,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);

    const persisted = await readPersistedStore(agentDir);
    const persistedProfile = requireOAuthProfile(persisted, profileId);
    expect(persistedProfile.accountId).toBe("acct-shared");
    expect(persistedProfile.access).toBe("local-access-token");
    expect(persistedProfile.refresh).toBe("local-refresh-token");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-access-token");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-refresh-token");
  });

  it("does not use same-account Codex CLI credentials for named Codex profiles after forced local refresh fails", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "local-access-token",
            refresh: "local-refresh-token",
            expires: Date.now() + 86_400_000,
            accountId: "acct-shared",
            email: "user@example.com",
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);

    const persisted = await readPersistedStore(agentDir);
    const persistedProfile = requireOAuthProfile(persisted, profileId);
    expect(persistedProfile.accountId).toBe("acct-shared");
    expect(persistedProfile.email).toBe("user@example.com");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-access-token");
    expect(JSON.stringify(persisted)).not.toContain("codex-cli-refresh-token");
  });

  it("fails closed instead of selecting Codex CLI after an unpinned managed refresh fails", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        accountId: "acct-shared",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "stale-codex-cli-access-token",
      refresh: "stale-codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockRejectedValueOnce(
      new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      ),
    );

    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        agentDir,
      }),
    ).rejects.toMatchObject({
      name: "OAuthRefreshFailureError",
      provider: "openai",
      profileId,
    });
  });

  it("does not refresh managed OAuth for direct OpenAI API-key models", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        accountId: "acct-shared",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "stale-codex-cli-access-token",
      refresh: "stale-codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    });

    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        modelApi: "openai-responses",
        agentDir,
      }),
    ).rejects.toThrow('No API key found for provider "openai"');
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("rejects explicit managed OAuth before refreshing for direct OpenAI API-key models", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        accountId: "acct-shared",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    await expect(
      resolveApiKeyForProvider({
        provider: "openai",
        modelApi: "openai-responses",
        profileId,
        lockedProfile: true,
        agentDir,
      }),
    ).rejects.toThrow(/requires an OpenAI API key profile/);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("does not refresh managed OAuth while checking direct OpenAI auth availability", async () => {
    const profileId = "openai:user@example.com";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
        accountId: "acct-shared",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    await expect(
      hasAvailableAuthForProvider({
        provider: "openai",
        modelApi: "openai-responses",
        agentDir,
      }),
    ).resolves.toBe(false);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched Codex CLI fallback after forced local refresh fails", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "local-access-token",
            refresh: "local-refresh-token",
            expires: Date.now() + 86_400_000,
            accountId: "acct-local",
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-other",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
  });

  it("rejects identity-less Codex CLI fallback after forced local refresh fails", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "local-access-token",
            refresh: "local-refresh-token",
            expires: Date.now() + 86_400_000,
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai",
      access: "codex-cli-access-token",
      refresh: "codex-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-cli",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
  });

  it("rejects unchanged Codex CLI fallback during forced refresh", async () => {
    const profileId = "openai:default";
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "shared-access-token",
      refresh: "shared-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-shared",
    };
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: credential,
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({ ...credential });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token is expired.","code":"refresh_token_expired"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
  });

  it("adopts fresher stored credentials after refresh_token_reused", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
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
              provider: "openai",
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
      provider: "openai",
      email: undefined,
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("clears stale lastGood before selecting an alternate Codex OAuth profile", async () => {
    const staleProfileId = "openai:default";
    const healthyProfileId = "openai:user@example.test";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [staleProfileId]: {
            type: "oauth",
            provider: "openai",
            access: "stale-access-token",
            refresh: "stale-refresh-token",
            expires: Date.now() - 60_000,
          },
          [healthyProfileId]: {
            type: "oauth",
            provider: "openai",
            access: "healthy-access-token",
            refresh: "healthy-refresh-token",
            expires: Date.now() + 60 * 60_000,
            email: "user@example.test",
          },
        },
        lastGood: { openai: staleProfileId },
      },
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId: staleProfileId,
        agentDir,
      }),
    ).resolves.toEqual({
      apiKey: "healthy-access-token",
      provider: "openai",
      email: "user@example.test",
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
    expect((await readPersistedStore(agentDir)).lastGood).toBeUndefined();
  });

  it("reports the alternate Codex OAuth profile after stale lastGood fallback", async () => {
    const staleProfileId = "openai:default";
    const healthyProfileId = "openai:user@example.test";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [staleProfileId]: {
            type: "oauth",
            provider: "openai",
            access: "stale-access-token",
            refresh: "stale-refresh-token",
            expires: Date.now() - 60_000,
          },
          [healthyProfileId]: {
            type: "oauth",
            provider: "openai",
            access: "healthy-access-token",
            refresh: "healthy-refresh-token",
            expires: Date.now() + 60 * 60_000,
            email: "user@example.test",
          },
        },
        lastGood: { openai: staleProfileId },
      },
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      store: ensureAuthProfileStore(agentDir),
      agentDir,
    });

    expect(resolved).toMatchObject({
      apiKey: "healthy-access-token",
      profileId: healthyProfileId,
      source: `profile:${healthyProfileId}`,
      mode: "oauth",
    });

    await markAuthProfileSuccess({
      store: ensureAuthProfileStore(agentDir),
      provider: "openai",
      profileId: resolved.profileId ?? "",
      agentDir,
    });
    expect(ensureAuthProfileStore(agentDir).lastGood?.openai).toBe(healthyProfileId);
  });

  it("retries Codex refresh once after refresh_token_reused updates only the stored refresh token", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
      }),
      agentDir,
    );
    getOAuthApiKeyMock
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai"]?.refresh).toBe("refresh-token");
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai",
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
        expect(creds["openai"]?.refresh).toBe("rotated-refresh-token");
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
      provider: "openai",
      email: undefined,
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    const persisted = await readPersistedStore(agentDir);
    expectPersistedOpenAICodexProfile(
      expectDefined(persisted.profiles[profileId], "persisted.profiles[profileId] test invariant"),
      {
        access: "retried-access-token",
        refresh: "retried-refresh-token",
      },
    );
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

  it("does not use fallback for unrelated openai refresh errors", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
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
    ).rejects.toThrow(/OAuth token refresh failed for openai/);
  });
});
