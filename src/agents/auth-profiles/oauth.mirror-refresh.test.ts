import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { __testing as externalAuthTesting } from "./external-auth.js";
import "./oauth-file-lock-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

function expectPersistedOpenAICodexProfileWithoutInlineTokens(
  credential: AuthProfileStore["profiles"][string],
  metadata: Record<string, unknown> = {},
): void {
  expect(credential).toMatchObject({
    type: "oauth",
    provider: "openai-codex",
    ...metadata,
  });
  expect(credential).not.toHaveProperty("access");
  expect(credential).not.toHaveProperty("refresh");
  expect(credential).not.toHaveProperty("idToken");
}

function requireOAuthCredential(store: AuthProfileStore, profileId: string): OAuthCredential {
  const profile = store.profiles[profileId];
  if (!profile || profile.type !== "oauth") {
    throw new Error(`expected OAuth credential for ${profileId}`);
  }
  return profile;
}

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: () => [{ id: "anthropic" }, { id: "openai-codex" }],
  getOAuthApiKey: vi.fn(async (provider: string, credentials: Record<string, OAuthCredential>) => {
    const credential = credentials[provider];
    return credential
      ? {
          apiKey: credential.access,
          newCredentials: credential,
        }
      : null;
  }),
}));

describe("resolveApiKeyForProfile OAuth refresh mirror-to-main (#26322)", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let caseIndex = 0;
  let mainAgentDir = "";

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-mirror-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
    clearRuntimeAuthProfileStoreSnapshots();
    caseIndex += 1;
    const caseRoot = path.join(tempRoot, `case-${caseIndex}`);
    mainAgentDir = await createOAuthMainAgentDir(caseRoot);
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("mirrors refreshed Codex OAuth metadata into the main store without inline tokens", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-mirror", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("sub-refreshed-access");

    // Main store should now carry refreshed metadata, so a peer agent
    // starting fresh can resolve the runtime credential without token races.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expectPersistedOpenAICodexProfileWithoutInlineTokens(mainRaw.profiles[profileId], {
      expires: freshExpiry,
      accountId,
    });
    expect(JSON.stringify(mainRaw)).not.toContain("sub-refreshed-access");
    expect(JSON.stringify(mainRaw)).not.toContain("sub-refreshed-refresh");
  });

  it("does not mirror when refresh was performed from the main agent itself", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, access: "main-stale-access" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "main-refreshed-access",
          refresh: "main-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    // Main-agent refresh uses undefined agentDir; the mirror path is a no-op
    // (local == main). Just make sure the main store still reflects the refresh
    // and no double-write happens.
    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(undefined),
      profileId,
      agentDir: undefined,
    });

    expect(result?.apiKey).toBe("main-refreshed-access");
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expectPersistedOpenAICodexProfileWithoutInlineTokens(mainRaw.profiles[profileId], {
      expires: freshExpiry,
    });
    expect(JSON.stringify(mainRaw)).not.toContain("main-refreshed-access");
    expect(JSON.stringify(mainRaw)).not.toContain("main-refreshed-refresh");
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("inherits main-agent credentials via the pre-refresh adopt path when main is already fresher", async () => {
    // Exercises adoptNewerMainOAuthCredential at the top of
    // resolveApiKeyForProfile: main is fresher at flow start, so we adopt
    // BEFORE the refresh attempt. End-user outcome: sub transparently uses
    // main's creds.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-fail-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-fresh-access",
            refresh: "main-fresh-refresh",
            expires: freshExpiry,
            accountId: "acct-shared",
          },
        },
      },
      mainAgentDir,
    );

    // Refresh mock intentionally left as default-undefined — it should not
    // be called, the pre-refresh adopt wins.
    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-fresh-access");
    expect(result?.provider).toBe(provider);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("answers app-server forced refresh from fresh main credentials when a sub-agent copy is expired", async () => {
    const profileId = "openai-codex:peter@example.test";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-app-server-force", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-shared",
        email: "peter@example.test",
      }),
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-fresh-access",
            refresh: "main-fresh-refresh",
            expires: freshExpiry,
            accountId: "acct-shared",
            email: "peter@example.test",
          },
        },
      },
      mainAgentDir,
    );

    const store = ensureAuthProfileStore(subAgentDir);
    const credential = store.profiles[profileId];
    if (!credential || credential.type !== "oauth") {
      throw new Error("expected seeded OAuth profile");
    }
    store.profiles[profileId] = { ...credential, expires: 0 };
    saveAuthProfileStore(store, subAgentDir);

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store,
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-fresh-access");
    expect(result?.provider).toBe(provider);
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
  });

  it("refreshes the main owner when a stale local OAuth clone shadows a newer main credential", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-stale-clone-owner", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "local-stale-access",
            refresh: "local-stale-refresh",
            expires: now - 120_000,
            accountId,
          },
        },
      },
      subAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "main-expired-access",
            refresh: "main-owner-refresh",
            expires: now - 60_000,
            accountId,
          },
        },
      },
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => {
        const credential = params?.context as OAuthCredential | undefined;
        expect(credential?.refresh).toBe("main-owner-refresh");
        return {
          access: "main-owner-refreshed-access",
          refresh: "main-owner-refreshed-refresh",
          expires: freshExpiry,
        } as never;
      },
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-owner-refreshed-access");
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);

    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expectPersistedOpenAICodexProfileWithoutInlineTokens(subRaw.profiles[profileId], {
      expires: now - 120_000,
      accountId,
    });
    expect(JSON.stringify(subRaw)).not.toContain("local-stale-access");
    expect(JSON.stringify(subRaw)).not.toContain("local-stale-refresh");

    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expectPersistedOpenAICodexProfileWithoutInlineTokens(mainRaw.profiles[profileId], {
      expires: freshExpiry,
      accountId,
    });
    expect(JSON.stringify(mainRaw)).not.toContain("main-owner-refreshed-access");
    expect(JSON.stringify(mainRaw)).not.toContain("main-owner-refreshed-refresh");
  });

  it("inherits main-agent credentials via the catch-block fallback when refresh throws after main becomes fresh", async () => {
    // Exercises the specific catch-block `if (params.agentDir) { mainStore … }`
    // branch (lines 826-848 in oauth.ts). Setup:
    //   1. sub + main BOTH expired at the start of resolveApiKeyForProfile,
    //      so adoptNewerMainOAuthCredential does not short-circuit.
    //   2. Inside refreshOAuthTokenWithLock, the plugin refresh mock writes
    //      fresh credentials into the main store and then throws a non-
    //      refresh_token_reused error. This simulates "another process
    //      completed a refresh just as ours failed".
    //   3. The catch block's loadFreshStoredOAuthCredential reads the sub
    //      store (still expired). Then the main-agent-inherit fallback
    //      kicks in and returns main's fresh creds read-through without copying
    //      the refresh token into the sub store.
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-catch-inherit", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-shared" }),
      mainAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      // Simulate another agent completing its refresh and writing fresh
      // creds to main, concurrent with our attempt.
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider,
              access: "main-side-refreshed-access",
              refresh: "main-side-refreshed-refresh",
              expires: freshExpiry,
              accountId: "acct-shared",
            },
          },
        },
        mainAgentDir,
      );
      // Now throw a non-refresh_token_reused error so we fall through the
      // recovery branches into the catch-block main-agent inherit.
      throw new Error("upstream 503 service unavailable");
    });

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-side-refreshed-access");
    expect(result?.provider).toBe(provider);

    // Sub-agent's store keeps its local expired credential; inherited OAuth is read-through.
    const subRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expectPersistedOpenAICodexProfileWithoutInlineTokens(subRaw.profiles[profileId], {
      accountId: "acct-shared",
    });
    expect(JSON.stringify(subRaw)).not.toContain("cached-access-token");
  });

  it("mirrors refreshed credentials produced by the plugin-refresh path", async () => {
    // The plugin-refreshed branch in doRefreshOAuthTokenWithLock has its own
    // mirror call; cover it separately so the branch is not orphaned.
    const profileId = "anthropic:plugin";
    const provider = "anthropic";
    const accountId = "acct-plugin";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-plugin", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), subAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    // Plugin returns a truthy refreshed credential — this takes the plugin
    // branch instead of falling through to getOAuthApiKey.
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          access: "plugin-refreshed-access",
          refresh: "plugin-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });
    expect(result?.apiKey).toBe("plugin-refreshed-access");

    // Main store must have been mirrored from the plugin-refresh branch.
    const mainRaw = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    const mainCredential = requireOAuthCredential(mainRaw, profileId);
    expect(mainCredential.access).toBe("plugin-refreshed-access");
    expect(mainCredential.refresh).toBe("plugin-refreshed-refresh");
    expect(mainCredential.expires).toBe(freshExpiry);
  });
});
