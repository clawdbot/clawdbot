/**
 * Regression: OAuth callers are bounded before queue admission while an
 * abandoned owner retains the global refresh lock until provider work settles.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } from "./store.js";
import type { OAuthCredential, OAuthCredentials } from "./types.js";

// Shrink the ownership deadline so a real-timer test can observe both the
// owner and its queued follower expire while provider work remains in flight.
vi.mock("./constants.js", async () => {
  const actual = await vi.importActual<typeof import("./constants.js")>("./constants.js");
  return {
    ...actual,
    OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS: 150,
    OAUTH_REFRESH_CALL_TIMEOUT_MS: 5_000,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withOAuthAgentDirs(
  prefix: string,
  run: (dirs: { mainAgentDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => {
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    await withEnvAsync({ OPENCLAW_AGENT_DIR: mainAgentDir }, async () => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(mainAgentDir, { recursive: true });
      await run({ mainAgentDir, agentDir });
    });
  });
}

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(() => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("abandoned OAuth refresh write-back", () => {
  it("bounds queued callers while retaining refresh ownership through write-back", async () => {
    await withOAuthAgentDirs("oauth-manager-abandoned-writeback-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const staleCredential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: staleCredential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      // The refresh call outlives the (shrunken) ownership deadline, then
      // completes with rotated tokens only after both callers were abandoned.
      let resolveRefresh: ((value: OAuthCredentials) => void) | undefined;
      const refreshCredential = vi
        .fn<(credential: OAuthCredential) => Promise<OAuthCredentials>>()
        .mockImplementationOnce(
          () =>
            new Promise<OAuthCredentials>((resolve) => {
              resolveRefresh = resolve;
            }),
        );
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      const firstPreparedStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      await expect(
        manager.resolveOAuthAccess({
          store: firstPreparedStore,
          profileId,
          credential: staleCredential,
          agentDir,
        }),
      ).rejects.toBeInstanceOf(OAuthManagerRefreshError);
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      clearRuntimeAuthProfileStoreSnapshots();
      const secondPreparedStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(secondPreparedStore).not.toBe(firstPreparedStore);
      // Prepared/remote-exec clients can hold distinct snapshots or live in
      // distinct processes. SQLite plus the file lock owns their handoff.
      const successor = manager.resolveOAuthAccess({
        store: secondPreparedStore,
        profileId,
        credential: staleCredential,
        agentDir,
        forceRefresh: true,
      });
      const successorOutcome = await Promise.race([
        successor.then(
          () => ({ status: "resolved" as const }),
          (error: unknown) => ({ error, status: "rejected" as const }),
        ),
        new Promise<{ status: "guard-expired" }>((resolve) => {
          setTimeout(() => resolve({ status: "guard-expired" }), 300);
        }),
      ]);
      // The follower's absolute deadline starts before queue admission. It
      // expires without reaching the provider or extending the retained owner.
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      // Let the abandoned continuation settle. Its rotated tokens are stored
      // before the lock releases. A fresh caller then adopts that rotation.
      resolveRefresh?.({
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 10 * 60_000,
      });
      await vi.waitFor(() => {
        clearRuntimeAuthProfileStoreSnapshots();
        const stored = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        });
        expect(stored.profiles[profileId]).toMatchObject({
          access: "rotated-access",
          refresh: "rotated-refresh",
        });
        const main = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
          allowKeychainPrompt: false,
        });
        expect(main.profiles[profileId]).toMatchObject({
          access: "rotated-access",
          refresh: "rotated-refresh",
        });
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(successorOutcome.status).toBe("rejected");
      if (successorOutcome.status === "rejected") {
        expect(successorOutcome.error).toBeInstanceOf(OAuthManagerRefreshError);
      }
      await expect(
        manager.resolveOAuthAccess({
          store: secondPreparedStore,
          profileId,
          credential: staleCredential,
          agentDir,
        }),
      ).resolves.toMatchObject({
        apiKey: "rotated-access",
        credential: {
          access: "rotated-access",
          refresh: "rotated-refresh",
        },
      });
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      clearRuntimeAuthProfileStoreSnapshots();
      const subStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(subStore.profiles[profileId]).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
      const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
        allowKeychainPrompt: false,
      });
      expect(mainStore.profiles[profileId]).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
      });
    });
  });
});
