/** Tests durable OAuth generation ownership across copied agent stores. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
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
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
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
        Array.from({ length: 2 }, async (_, i) => {
          const dir = path.join(tempRoot, "agents", `sub-${i}`, "agent");
          await fs.mkdir(dir, { recursive: true });
          const local = createExpiredOauthStore({ profileId, provider });
          const credential = local.profiles[profileId];
          if (credential?.type === "oauth") {
            // Access and expiry can drift while the single-use refresh generation stays shared.
            credential.access = `local-drifted-access-${i}`;
            credential.expires = Date.now() - 1_000;
          }
          saveAuthProfileStore(local, dir);
          return dir;
        }),
      );
      const mainStore = createExpiredOauthStore({ profileId, provider });
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
          agentDir: subAgents[1],
          profileId,
        }),
      ).toBeUndefined();
      const second = resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(subAgents[1]),
        profileId,
        agentDir: subAgents[1],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(callCount).toBe(1);
      await vi.waitFor(() => {
        for (const agentDir of subAgents) {
          const fenced = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
          expect(fenced?.type === "oauth" ? fenced.access : "").toMatch(
            /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
          );
          expect(fenced?.type === "oauth" ? fenced.refresh : "").toMatch(
            /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
          );
        }
      });

      finishRefresh?.();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({
          apiKey: "cross-agent-refreshed-access",
          provider,
        }),
        expect.objectContaining({
          apiKey: "cross-agent-refreshed-access",
          provider,
        }),
      ]);
      expect(callCount).toBe(1);
      for (const agentDir of subAgents) {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toMatchObject({
          access: "cross-agent-refreshed-access",
          refresh: "cross-agent-refreshed-refresh",
          expires: freshExpiry,
        });
      }
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  }, 10_000);

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
});
