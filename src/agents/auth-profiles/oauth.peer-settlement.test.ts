/** Tests identity-safe settlement of copied OAuth refresh peers. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import {
  fenceOAuthRefreshPeers,
  rollbackOAuthRefreshPeerClaims,
  settleOAuthRefreshPeerClaims,
} from "./oauth-refresh-peers.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  const { resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js");
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

function resetOAuthTestState(): void {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
}

describe("OAuth refresh peer settlement", () => {
  it.each([
    ["pending", (fence: ReturnType<typeof createOAuthRefreshFence>) => fence],
    ["failed", createFailedOAuthRefreshFence],
  ])("does not replace a different %s fence for the same refresh generation", async (_, build) => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-competing-fence-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const profileId = "openai:default";
      const provider = "openai";
      const original = {
        type: "oauth" as const,
        provider,
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };
      const ownerFence = createOAuthRefreshFence({ profileId, credential: original });
      const competingFence = build(createOAuthRefreshFence({ profileId, credential: original }));
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: competingFence } }, peerAgentDir);

      await expect(
        fenceOAuthRefreshPeers({
          cfg: {},
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainAgentDir),
          profileId,
          generation: original,
          fence: ownerFence,
        }),
      ).rejects.toThrow("already claimed");
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toEqual(
        competingFence,
      );
    } finally {
      envSnapshot.restore();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("terminally fences peers instead of exposing a different shared account", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetOAuthTestState();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-account-mismatch-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const ownerAgentDir = path.join(tempRoot, "agents", "owner-a", "agent");
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await Promise.all([
        fs.mkdir(ownerAgentDir, { recursive: true }),
        fs.mkdir(peerAgentDir, { recursive: true }),
      ]);
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      const accountA = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
      });
      const accountB = createExpiredOauthStore({
        profileId,
        provider,
        access: "shared-b-access",
        refresh: "shared-b-refresh",
        accountId: "acct-b",
      });
      const sharedB = accountB.profiles[profileId];
      if (sharedB?.type !== "oauth") {
        throw new Error("expected shared OAuth credential");
      }
      sharedB.expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(accountA, ownerAgentDir);
      saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), peerAgentDir);
      saveAuthProfileStore(accountB, mainAgentDir);
      refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
        type: "oauth",
        provider,
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      });

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(ownerAgentDir),
          profileId,
          agentDir: ownerAgentDir,
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));

      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "shared-b-access",
        accountId: "acct-b",
      });
      expect(loadPersistedAuthProfileStore(ownerAgentDir)?.profiles[profileId]).toMatchObject({
        access: "rotated-a-access",
        accountId: "acct-a",
      });
      const terminalPeer = loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId];
      expect(terminalPeer?.type === "oauth" && isOAuthRefreshFence(terminalPeer)).toBe(true);
      expect(terminalPeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalPeer)).toBe(
        false,
      );
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(peerAgentDir),
          profileId,
          agentDir: peerAgentDir,
        }),
      ).resolves.toBeNull();
    } finally {
      envSnapshot.restore();
      resetOAuthTestState();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("retires an identity-less peer for the exact owner-produced replacement", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetOAuthTestState();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-identityless-exact-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      saveAuthProfileStore(
        createExpiredOauthStore({ profileId, provider, accountId: "acct-a" }),
        mainAgentDir,
      );
      saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), peerAgentDir);
      refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
        type: "oauth",
        provider,
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      });

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(peerAgentDir),
          profileId,
          agentDir: peerAgentDir,
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "rotated-a-access",
        accountId: "acct-a",
      });
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toBeUndefined();
    } finally {
      envSnapshot.restore();
      resetOAuthTestState();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it.each([
    {
      name: "conflicting account ids",
      identity: { accountId: "acct-b" },
      retired: false,
    },
    {
      name: "conflicting emails",
      identity: { email: "b@example.com" },
      retired: false,
    },
    {
      name: "conflicting account ids despite matching email",
      identity: { accountId: "acct-b", email: "a@example.com" },
      retired: false,
    },
    {
      name: "identity-less peer",
      identity: {},
      retired: true,
    },
    {
      name: "matching identity",
      identity: { accountId: "acct-a" },
      retired: true,
    },
  ])("settles an exact replacement safely for $name", async ({ identity, retired }) => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-exact-settlement-");
      await createOAuthMainAgentDir(tempRoot);
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const profileId = "openai:default";
      const provider = "openai";
      const ownerOriginal = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
        email: "a@example.com",
      }).profiles[profileId];
      if (ownerOriginal?.type !== "oauth") {
        throw new Error("expected owner OAuth credential");
      }
      const peerOriginal = {
        ...ownerOriginal,
        accountId: undefined,
        email: undefined,
        ...identity,
      };
      const fence = createOAuthRefreshFence({ profileId, credential: ownerOriginal });
      const replacement = {
        ...ownerOriginal,
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, peerAgentDir);
      const persistedFence = loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId];
      if (persistedFence?.type !== "oauth") {
        throw new Error("expected persisted OAuth fence");
      }

      settleOAuthRefreshPeerClaims({
        profileId,
        fence: persistedFence,
        claims: [
          {
            candidate: {
              agentId: "peer-a",
              agentDir: peerAgentDir,
              databasePath: resolveAuthProfileDatabasePath(peerAgentDir),
              env: process.env,
            },
            original: peerOriginal,
          },
        ],
        authoritativeSharedCredential: replacement,
        replacement,
      });

      const settled = loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId];
      if (retired) {
        expect(settled).toBeUndefined();
      } else {
        expect(settled?.type === "oauth" && isOAuthRefreshFence(settled)).toBe(true);
        expect(settled?.type === "oauth" && isPendingOAuthRefreshFence(settled)).toBe(false);
      }
    } finally {
      envSnapshot.restore();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("continues rolling back peers after one candidate cannot be restored or terminalized", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-peer-rollback-");
      await createOAuthMainAgentDir(tempRoot);
      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({ profileId, provider }).profiles[profileId];
      if (original?.type !== "oauth") {
        throw new Error("expected original OAuth credential");
      }
      const fence = createOAuthRefreshFence({ profileId, credential: original });
      const brokenAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      const healthyAgentDir = path.join(tempRoot, "agents", "peer-b", "agent");
      await Promise.all([
        fs.mkdir(brokenAgentDir, { recursive: true }),
        fs.mkdir(healthyAgentDir, { recursive: true }),
      ]);
      await fs.writeFile(resolveAuthProfileDatabasePath(brokenAgentDir), "not a sqlite database");
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, healthyAgentDir);
      const persistedFence = loadPersistedAuthProfileStore(healthyAgentDir)?.profiles[profileId];
      if (persistedFence?.type !== "oauth") {
        throw new Error("expected persisted OAuth fence");
      }

      expect(() =>
        rollbackOAuthRefreshPeerClaims({
          profileId,
          fence: persistedFence,
          claims: [
            {
              candidate: {
                agentId: "peer-b",
                agentDir: healthyAgentDir,
                databasePath: resolveAuthProfileDatabasePath(healthyAgentDir),
                env: process.env,
              },
              original,
            },
            {
              candidate: {
                agentId: "peer-a",
                agentDir: brokenAgentDir,
                databasePath: resolveAuthProfileDatabasePath(brokenAgentDir),
                env: process.env,
              },
              original,
            },
          ],
        }),
      ).toThrow(AggregateError);
      expect(loadPersistedAuthProfileStore(healthyAgentDir)?.profiles[profileId]).toMatchObject({
        type: "oauth",
        provider,
        access: original.access,
        refresh: original.refresh,
        expires: original.expires,
      });
    } finally {
      envSnapshot.restore();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("terminally fences superseded peers when shared inheritance is a different account", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetOAuthTestState();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-relogin-mismatch-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const ownerAgentDir = path.join(tempRoot, "agents", "owner-a", "agent");
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await Promise.all([
        fs.mkdir(ownerAgentDir, { recursive: true }),
        fs.mkdir(peerAgentDir, { recursive: true }),
      ]);
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      const accountA = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
      });
      const accountB = createExpiredOauthStore({
        profileId,
        provider,
        access: "shared-b-access",
        refresh: "shared-b-refresh",
        accountId: "acct-b",
      });
      const sharedB = accountB.profiles[profileId];
      if (sharedB?.type !== "oauth") {
        throw new Error("expected shared OAuth credential");
      }
      sharedB.expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(accountA, ownerAgentDir);
      saveAuthProfileStore(accountA, peerAgentDir);
      saveAuthProfileStore(accountB, mainAgentDir);

      let finishRefresh: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return undefined;
      });

      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(ownerAgentDir),
        profileId,
        agentDir: ownerAgentDir,
      });
      await started;
      await persistAuthProfileBatch({
        agentDir: ownerAgentDir,
        profiles: [
          {
            profileId,
            credential: {
              type: "oauth",
              provider,
              access: "relogin-a-access",
              refresh: "relogin-a-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              accountId: "acct-a",
            },
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      finishRefresh?.();

      await expect(resolving).resolves.toEqual(
        expect.objectContaining({ apiKey: "relogin-a-access" }),
      );
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "shared-b-access",
        accountId: "acct-b",
      });
      const terminalPeer = loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId];
      expect(terminalPeer?.type === "oauth" && isOAuthRefreshFence(terminalPeer)).toBe(true);
      expect(terminalPeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalPeer)).toBe(
        false,
      );
    } finally {
      envSnapshot.restore();
      resetOAuthTestState();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("does not republish a refresh generation removed during provider I/O", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetOAuthTestState();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-logout-race-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
      });
      saveAuthProfileStore(original, mainAgentDir);
      saveAuthProfileStore(original, peerAgentDir);

      let finishRefresh: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return {
          type: "oauth",
          provider,
          access: "late-rotated-access",
          refresh: "late-rotated-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-a",
        } as never;
      });

      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(peerAgentDir),
        profileId,
        agentDir: peerAgentDir,
      });
      await started;
      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [profileId],
        agentDir: mainAgentDir,
      });
      finishRefresh?.();

      await expect(resolving).rejects.toThrow("Failed to persist refreshed OAuth credential");
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toBeUndefined();
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toBeUndefined();
    } finally {
      envSnapshot.restore();
      resetOAuthTestState();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });
});
