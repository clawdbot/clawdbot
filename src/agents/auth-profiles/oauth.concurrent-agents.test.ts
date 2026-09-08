/** Tests durable OAuth generation ownership across copied agent stores. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { failOAuthRefreshPeerClaims } from "./oauth-refresh-peers.js";
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
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.test-support.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js"));
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }, { id: "minimax-portal" }],
}));

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  it("gives one copied refresh generation one durable main-store owner", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-concurrent-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      const freshExpiry = Date.now() + 60 * 60 * 1000;
      const subAgents = await Promise.all(
        Array.from({ length: 5 }, async (_, i) => {
          const dir = path.join(tempRoot, "agents", `sub-${i}`, "agent");
          await fs.mkdir(dir, { recursive: true });
          const local = createExpiredOauthStore({ profileId, provider, accountId: "acct-a" });
          const credential = local.profiles[profileId];
          if (credential?.type === "oauth") {
            // Access and expiry can drift while the single-use refresh generation stays shared.
            credential.access = `local-drifted-access-${i}`;
            credential.expires = Date.now() - 1_000;
            if (i === 3) {
              credential.refresh = "independent-refresh-generation";
              credential.access = "independent-access";
              credential.expires = freshExpiry;
            } else if (i === 4) {
              credential.copyToAgents = true;
              credential.access = "portable-access";
              credential.expires = freshExpiry;
            }
          }
          local.order = { openai: [profileId] };
          local.usageStats = { [profileId]: { lastUsed: i + 1 } };
          saveAuthProfileStore(local, dir);
          return dir;
        }),
      );
      const mainStore = createExpiredOauthStore({ profileId, provider, accountId: "acct-a" });
      const mainCredential = mainStore.profiles[profileId];
      if (mainCredential?.type === "oauth") {
        mainCredential.access = "main-drifted-access";
      }
      saveAuthProfileStore(mainStore, mainAgentDir);

      let callCount = 0;
      let finishRefresh: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
        callCount += 1;
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return {
          type: "oauth",
          provider,
          access: "cross-agent-refreshed-access",
          refresh: "cross-agent-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-a",
        } as never;
      });

      const first = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(subAgents[0]),
        profileId,
        agentDir: subAgents[0],
      });
      await started;
      expect(
        resolvePersistedAuthProfileOwnerAgentDir({
          agentDir: subAgents[2],
          profileId,
        }),
      ).toBeUndefined();
      expect(callCount).toBe(1);
      await vi.waitFor(() => {
        for (const agentDir of subAgents.slice(0, 3)) {
          const fenced = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
          expect(fenced?.type === "oauth" ? fenced.access : "").toMatch(
            /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
          );
          expect(fenced?.type === "oauth" ? fenced.refresh : "").toMatch(
            /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
          );
        }
      });
      expect(loadPersistedAuthProfileStore(subAgents[3])?.profiles[profileId]).toMatchObject({
        refresh: "independent-refresh-generation",
      });
      expect(loadPersistedAuthProfileStore(subAgents[4])?.profiles[profileId]).toMatchObject({
        copyToAgents: true,
        refresh: "refresh-token",
      });

      finishRefresh?.();
      await expect(first).resolves.toEqual(
        expect.objectContaining({
          apiKey: "cross-agent-refreshed-access",
          provider,
        }),
      );
      expect(callCount).toBe(1);
      for (const [index, agentDir] of subAgents.slice(0, 3).entries()) {
        const persisted = loadPersistedAuthProfileStore(agentDir);
        expect(persisted?.profiles[profileId]).toBeUndefined();
        expect(persisted?.order?.openai).toEqual([profileId]);
        expect(persisted?.usageStats?.[profileId]?.lastUsed).toBe(index + 1);
      }
      expect(loadPersistedAuthProfileStore(subAgents[3])?.profiles[profileId]).toMatchObject({
        access: "independent-access",
        refresh: "independent-refresh-generation",
      });
      expect(loadPersistedAuthProfileStore(subAgents[4])?.profiles[profileId]).toMatchObject({
        access: "portable-access",
        copyToAgents: true,
      });

      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [profileId],
        agentDir: mainAgentDir,
      });
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(subAgents[2]),
          profileId,
          agentDir: subAgents[2],
        }),
      ).resolves.toBeNull();
      clearRuntimeAuthProfileStoreSnapshots();
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(subAgents[2]),
          profileId,
          agentDir: subAgents[2],
        }),
      ).resolves.toBeNull();
      expect(callCount).toBe(1);
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(subAgents[3]),
          profileId,
          agentDir: subAgents[3],
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "independent-access" }));
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(subAgents[4]),
          profileId,
          agentDir: subAgents[4],
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "portable-access" }));
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  }, 10_000);

  it("keeps pending observers read-only until the owner claims a late peer", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-late-peer-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const latePeerAgentDir = path.join(tempRoot, "agents", "late-peer", "agent");
      await fs.mkdir(latePeerAgentDir, { recursive: true });
      const profileId = "openai:default";
      const provider = "openai";
      const originalStore = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
      });
      const original = originalStore.profiles[profileId];
      if (original?.type !== "oauth") {
        throw new Error("expected original OAuth credential");
      }
      saveAuthProfileStore(originalStore, mainAgentDir);

      let finishRefresh: (() => void) | undefined;
      let markRefreshStarted: (() => void) | undefined;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const refreshCredential = vi.fn(async () => {
        markRefreshStarted?.();
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return {
          type: "oauth" as const,
          provider,
          access: "rotated-a-access",
          refresh: "rotated-a-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-a",
        };
      });
      const createManager = (onBootstrap?: () => void) =>
        createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          refreshCredential,
          canRefreshCredential: async () => true,
          readBootstrapCredential: () => {
            onBootstrap?.();
            return null;
          },
        });

      const owner = createManager().resolveOAuthAccess({
        store: ensureAuthProfileStore(mainAgentDir),
        profileId,
        credential: original,
        agentDir: mainAgentDir,
      });
      await refreshStarted;
      writePersistedAuthProfileStoreRaw(originalStore, latePeerAgentDir);

      let markObserverEntered: (() => void) | undefined;
      const observerEntered = new Promise<void>((resolve) => {
        markObserverEntered = resolve;
      });
      const observer = createManager(markObserverEntered).resolveOAuthAccess({
        store: ensureAuthProfileStore(mainAgentDir),
        profileId,
        credential: original,
        agentDir: mainAgentDir,
      });
      await observerEntered;
      await withOAuthProfileLock({ provider, profileId }, async () => {});

      expect(loadPersistedAuthProfileStore(latePeerAgentDir)?.profiles[profileId]).toEqual(
        original,
      );
      expect(refreshCredential).toHaveBeenCalledOnce();

      finishRefresh?.();
      await expect(owner).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));
      await expect(observer).resolves.toEqual(
        expect.objectContaining({ apiKey: "rotated-a-access" }),
      );
      expect(loadPersistedAuthProfileStore(latePeerAgentDir)?.profiles[profileId]).toBeUndefined();
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("allows only one independent manager to own a late local refresh generation", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-independent-managers-");
      await createOAuthMainAgentDir(tempRoot);
      const firstAgentDir = path.join(tempRoot, "agents", "first", "agent");
      const secondAgentDir = path.join(tempRoot, "agents", "second", "agent");
      await Promise.all([
        fs.mkdir(firstAgentDir, { recursive: true }),
        fs.mkdir(secondAgentDir, { recursive: true }),
      ]);
      const profileId = "openai:default";
      const provider = "openai";
      const originalStore = createExpiredOauthStore({
        profileId,
        provider,
        accountId: "acct-a",
      });
      const original = originalStore.profiles[profileId];
      if (original?.type !== "oauth") {
        throw new Error("expected original OAuth credential");
      }
      saveAuthProfileStore(originalStore, firstAgentDir);

      let finishFirstRefresh: (() => void) | undefined;
      let markFirstRefreshStarted: (() => void) | undefined;
      const firstRefreshStarted = new Promise<void>((resolve) => {
        markFirstRefreshStarted = resolve;
      });
      const refreshCredential = vi.fn(async () => {
        if (refreshCredential.mock.calls.length === 1) {
          markFirstRefreshStarted?.();
          await new Promise<void>((resolve) => {
            finishFirstRefresh = resolve;
          });
        }
        return {
          type: "oauth" as const,
          provider,
          access: "rotated-a-access",
          refresh: "rotated-a-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-a",
        };
      });
      const createManager = () =>
        createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          refreshCredential,
          canRefreshCredential: async () => true,
          readBootstrapCredential: () => null,
        });

      const first = createManager().resolveOAuthAccess({
        store: ensureAuthProfileStore(firstAgentDir),
        profileId,
        credential: original,
        agentDir: firstAgentDir,
      });
      await firstRefreshStarted;
      const firstFence = loadPersistedAuthProfileStore(firstAgentDir)?.profiles[profileId];
      expect(firstFence?.type === "oauth" && isPendingOAuthRefreshFence(firstFence)).toBe(true);

      writePersistedAuthProfileStoreRaw(originalStore, secondAgentDir);
      await expect(
        createManager().resolveOAuthAccess({
          store: ensureAuthProfileStore(secondAgentDir),
          profileId,
          credential: original,
          agentDir: secondAgentDir,
        }),
      ).rejects.toThrow("historical OAuth refresh peer");

      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(loadPersistedAuthProfileStore(firstAgentDir)?.profiles[profileId]).toEqual(firstFence);
      expect(loadPersistedAuthProfileStore(secondAgentDir)?.profiles[profileId]).toEqual(original);

      finishFirstRefresh?.();
      await expect(first).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));
      expect(loadPersistedAuthProfileStore(secondAgentDir)?.profiles[profileId]).toBeUndefined();
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("terminally fences a copied generation when its main owner already failed", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-terminal-copy-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const copiedAgentDir = path.join(tempRoot, "agents", "sub", "agent");
      await fs.mkdir(copiedAgentDir, { recursive: true });
      await loadOAuthModuleForTest();

      const profileId = "openai:default";
      const provider = "openai";
      const mainStore = createExpiredOauthStore({ profileId, provider });
      const mainCredential = mainStore.profiles[profileId];
      if (mainCredential?.type !== "oauth") {
        throw new Error("expected main OAuth credential");
      }
      const failedFence = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({ profileId, credential: mainCredential }),
      );
      const copiedStore = createExpiredOauthStore({ profileId, provider });
      saveAuthProfileStore(copiedStore, copiedAgentDir);
      mainStore.profiles[profileId] = failedFence;
      saveAuthProfileStore(mainStore, mainAgentDir);
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(copiedAgentDir),
          profileId,
          agentDir: copiedAgentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
      expect(loadPersistedAuthProfileStore(copiedAgentDir)?.profiles[profileId]).toEqual(
        failedFence,
      );
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("terminally fences every peer when the provider refresh fails", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-peer-failure-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const peers = await Promise.all(
        Array.from({ length: 3 }, async (_, index) => {
          const agentDir = path.join(tempRoot, "agents", `peer-${index}`, "agent");
          await fs.mkdir(agentDir, { recursive: true });
          saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);
          return agentDir;
        }),
      );
      saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), mainAgentDir);
      refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(peers[0]),
          profileId,
          agentDir: peers[0],
        }),
      ).resolves.toBeNull();

      for (const agentDir of [mainAgentDir, ...peers]) {
        const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
        expect(credential?.type === "oauth" && isOAuthRefreshFence(credential)).toBe(true);
        expect(credential?.type === "oauth" && isPendingOAuthRefreshFence(credential)).toBe(false);
      }

      saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), peers[0]);
      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [profileId],
        agentDir: mainAgentDir,
      });
      for (const agentDir of [mainAgentDir, ...peers]) {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
      }
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("continues terminalizing peers after one candidate update fails", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-peer-terminalize-");
      await createOAuthMainAgentDir(tempRoot);
      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({ profileId, provider }).profiles[profileId];
      if (original?.type !== "oauth") {
        throw new Error("expected original OAuth credential");
      }
      const fence = createOAuthRefreshFence({ profileId, credential: original });
      const unreadableAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      const readableAgentDir = path.join(tempRoot, "agents", "peer-b", "agent");
      await fs.mkdir(unreadableAgentDir, { recursive: true });
      await fs.mkdir(readableAgentDir, { recursive: true });
      await fs.writeFile(
        resolveAuthProfileDatabasePath(unreadableAgentDir),
        "not a sqlite database",
      );
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, readableAgentDir);
      const persistedFence = loadPersistedAuthProfileStore(readableAgentDir)?.profiles[profileId];
      if (persistedFence?.type !== "oauth") {
        throw new Error("expected persisted OAuth fence");
      }

      expect(() =>
        failOAuthRefreshPeerClaims({
          profileId,
          fence: persistedFence,
          claims: [
            {
              candidate: {
                agentId: "peer-a",
                agentDir: unreadableAgentDir,
                databasePath: resolveAuthProfileDatabasePath(unreadableAgentDir),
                env: process.env,
              },
            },
            {
              candidate: {
                agentId: "peer-b",
                agentDir: readableAgentDir,
                databasePath: resolveAuthProfileDatabasePath(readableAgentDir),
                env: process.env,
              },
            },
          ],
        }),
      ).toThrow();
      const terminal = loadPersistedAuthProfileStore(readableAgentDir)?.profiles[profileId];
      expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
      expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(false);
    } finally {
      envSnapshot.restore();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("rejects a same-generation login write while refresh owns the generation", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-login-fence-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const original = createExpiredOauthStore({ profileId, provider });
      saveAuthProfileStore(original, mainAgentDir);

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
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 60 * 60 * 1000,
        } as never;
      });

      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(mainAgentDir),
        profileId,
        agentDir: mainAgentDir,
      });
      await started;
      const originalCredential = original.profiles[profileId];
      if (originalCredential?.type !== "oauth") {
        throw new Error("expected original OAuth credential");
      }
      await expect(
        persistAuthProfileBatch({
          agentDir: mainAgentDir,
          profiles: [{ profileId, credential: originalCredential }],
          resetFailureState: true,
          allowOAuthGenerationReplacement: true,
        }),
      ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
      const ownerFence = loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId];
      expect(ownerFence?.type === "oauth" && isOAuthRefreshFence(ownerFence)).toBe(true);

      finishRefresh?.();
      await expect(resolving).resolves.toEqual(
        expect.objectContaining({ apiKey: "rotated-access" }),
      );
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("retains the consumed generation when the settlement rescan finds an unreadable candidate", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-settlement-rescan-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const originalStore = createExpiredOauthStore({ profileId, provider });
      saveAuthProfileStore(originalStore, peerAgentDir);
      saveAuthProfileStore(originalStore, mainAgentDir);

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
          access: "preserved-rotation-access",
          refresh: "preserved-rotation-refresh",
          expires: Date.now() + 60 * 60 * 1000,
        } as never;
      });

      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(peerAgentDir),
        profileId,
        agentDir: peerAgentDir,
      });
      await started;
      const unreadableAgentDir = path.join(tempRoot, "agents", "peer-z", "agent");
      await fs.mkdir(unreadableAgentDir, { recursive: true });
      await fs.writeFile(
        resolveAuthProfileDatabasePath(unreadableAgentDir),
        "not a sqlite database",
      );
      finishRefresh?.();

      await expect(resolving).rejects.toThrow(
        "Failed to fence every historical OAuth refresh peer",
      );
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
      for (const agentDir of [mainAgentDir, peerAgentDir]) {
        const terminal = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
        expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
        expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(false);
        expect(terminal).not.toMatchObject({
          access: "preserved-rotation-access",
          refresh: "preserved-rotation-refresh",
        });
      }

      closeOpenClawAgentDatabasesForTest(tempRoot);
      await fs.rm(resolveAuthProfileDatabasePath(unreadableAgentDir), { force: true });
      writePersistedAuthProfileStoreRaw(originalStore, unreadableAgentDir);
      clearRuntimeAuthProfileStoreSnapshots();

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(mainAgentDir),
          profileId,
          agentDir: mainAgentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
      const terminalLatePeer =
        loadPersistedAuthProfileStore(unreadableAgentDir)?.profiles[profileId];
      expect(terminalLatePeer?.type === "oauth" && isOAuthRefreshFence(terminalLatePeer)).toBe(
        true,
      );
      expect(
        terminalLatePeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalLatePeer),
      ).toBe(false);
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("lets a completed re-login replace the owner while retiring consumed peers", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-relogin-race-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const peers = await Promise.all(
        Array.from({ length: 2 }, async (_, index) => {
          const agentDir = path.join(tempRoot, "agents", `peer-${index}`, "agent");
          await fs.mkdir(agentDir, { recursive: true });
          saveAuthProfileStore(
            createExpiredOauthStore({ profileId, provider, accountId: "acct-a" }),
            agentDir,
          );
          return agentDir;
        }),
      );
      saveAuthProfileStore(
        createExpiredOauthStore({ profileId, provider, accountId: "acct-a" }),
        mainAgentDir,
      );

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
          access: "stale-rotation-access",
          refresh: "stale-rotation-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-a",
        } as never;
      });

      const resolving = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(peers[0]),
        profileId,
        agentDir: peers[0],
      });
      await started;
      await persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [
          {
            profileId,
            credential: {
              type: "oauth",
              provider,
              access: "relogin-access",
              refresh: "relogin-refresh",
              expires: Date.now() + 60 * 60 * 1000,
              accountId: "acct-a",
            },
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "relogin-access",
        refresh: "relogin-refresh",
      });
      finishRefresh?.();

      await expect(resolving).resolves.toEqual(
        expect.objectContaining({ apiKey: "relogin-access" }),
      );
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toMatchObject({
        access: "relogin-access",
        refresh: "relogin-refresh",
      });
      for (const agentDir of peers) {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
      }
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("rolls back the owner and fenced peers when a candidate is unreadable", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-peer-rollback-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const profileId = "openai:default";
      const provider = "openai";
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      const unreadableAgentDir = path.join(tempRoot, "agents", "peer-z", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      await fs.mkdir(unreadableAgentDir, { recursive: true });
      const original = createExpiredOauthStore({ profileId, provider });
      saveAuthProfileStore(original, peerAgentDir);
      saveAuthProfileStore(original, mainAgentDir);
      await fs.writeFile(
        path.join(unreadableAgentDir, "openclaw-agent.sqlite"),
        "not a sqlite database",
      );
      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(peerAgentDir),
          profileId,
          agentDir: peerAgentDir,
        }),
      ).rejects.toThrow();
      expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[profileId]).toEqual(
        original.profiles[profileId],
      );
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[profileId]).toEqual(
        original.profiles[profileId],
      );
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });
});
