/** Tests identity-safe settlement of copied OAuth refresh peers. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { isOAuthRefreshFence, isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
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
import { removeAuthProfilesWithLock } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { upsertAuthProfileAfterLoginWithLockOrThrow } from "./upsert-with-lock.js";

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
      saveAuthProfileStore(accountA, peerAgentDir);
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
      await upsertAuthProfileAfterLoginWithLockOrThrow({
        profileId,
        agentDir: ownerAgentDir,
        credential: {
          type: "oauth",
          provider,
          access: "relogin-a-access",
          refresh: "relogin-a-refresh",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-a",
        },
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
      await removeAuthProfilesWithLock({ profileIds: [profileId], agentDir: mainAgentDir });
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
