import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION, MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { fenceOAuthRefreshPeers } from "./oauth-refresh-peers.js";
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
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
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

describe("OAuth external owner boundaries", () => {
  it("refuses native refresh when durable metadata assigns the owner to an external CLI", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-external-owner-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const credential = createExpiredOauthStore({
        profileId: MINIMAX_CLI_PROFILE_ID,
        provider: "minimax-portal",
        authFlow: "external-cli",
      });
      saveAuthProfileStore(credential, mainAgentDir);

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(mainAgentDir),
          profileId: MINIMAX_CLI_PROFILE_ID,
          agentDir: mainAgentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
        credential.profiles[MINIMAX_CLI_PROFILE_ID],
      );
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("refreshes an unmarked historical MiniMax native credential", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-legacy-minimax-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const credential = createExpiredOauthStore({
        profileId: MINIMAX_CLI_PROFILE_ID,
        provider: "minimax-portal",
      });
      saveAuthProfileStore(credential, mainAgentDir);
      refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
        type: "oauth",
        provider: "minimax-portal",
        access: "historical-native-refreshed-access",
        refresh: "historical-native-refreshed-refresh",
        expires: Date.now() + 60_000,
      });

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(mainAgentDir),
          profileId: MINIMAX_CLI_PROFILE_ID,
          agentDir: mainAgentDir,
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "historical-native-refreshed-access" }));
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("lets native device-code login reclaim the reserved MiniMax CLI profile id", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      resetFileLockStateForTest();
      resetOAuthProviderRuntimeMocks({
        refreshProviderOAuthCredentialWithPluginMock,
        formatProviderAuthProfileApiKeyWithPluginMock,
      });
      clearRuntimeAuthProfileStoreSnapshots();
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-native-minimax-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      await loadOAuthModuleForTest();
      const credential = createExpiredOauthStore({
        profileId: MINIMAX_CLI_PROFILE_ID,
        provider: "minimax-portal",
        authFlow: "external-cli",
      });
      saveAuthProfileStore(credential, mainAgentDir);
      const nativeCredential = createExpiredOauthStore({
        profileId: MINIMAX_CLI_PROFILE_ID,
        provider: "minimax-portal",
        authFlow: "device-code",
      }).profiles[MINIMAX_CLI_PROFILE_ID];
      if (nativeCredential?.type !== "oauth") {
        throw new Error("expected native MiniMax OAuth credential");
      }
      await persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [{ profileId: MINIMAX_CLI_PROFILE_ID, credential: nativeCredential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
        nativeCredential,
      );
      refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
        type: "oauth",
        provider: "minimax-portal",
        access: "native-refreshed-access",
        refresh: "native-refreshed-refresh",
        expires: Date.now() + 60_000,
      });

      await expect(
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(mainAgentDir),
          profileId: MINIMAX_CLI_PROFILE_ID,
          agentDir: mainAgentDir,
        }),
      ).resolves.toEqual(expect.objectContaining({ apiKey: "native-refreshed-access" }));
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
      expect(
        loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID],
      ).toMatchObject({
        access: "native-refreshed-access",
        refresh: "native-refreshed-refresh",
      });
    } finally {
      envSnapshot.restore();
      resetFileLockStateForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });

  it("refuses to claim a generation still owned by a persisted external CLI profile", async () => {
    const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
    let tempRoot = "";

    try {
      tempRoot = await createOAuthTestTempRoot("openclaw-oauth-external-peer-");
      const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
      const peerAgentDir = path.join(tempRoot, "agents", "external-peer", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const provider = "minimax-portal";
      const credential = createExpiredOauthStore({
        profileId: MINIMAX_CLI_PROFILE_ID,
        provider,
        authFlow: "external-cli",
      }).profiles[MINIMAX_CLI_PROFILE_ID];
      if (credential?.type !== "oauth") {
        throw new Error("expected external OAuth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: { [MINIMAX_CLI_PROFILE_ID]: credential },
        },
        peerAgentDir,
      );

      await expect(
        fenceOAuthRefreshPeers({
          cfg: {},
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainAgentDir),
          profileId: MINIMAX_CLI_PROFILE_ID,
          generation: credential,
          fence: createOAuthRefreshFence({
            profileId: MINIMAX_CLI_PROFILE_ID,
            credential,
          }),
        }),
      ).rejects.toThrow("still owned by an external credential source");
      expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
        credential,
      );
    } finally {
      envSnapshot.restore();
      await removeOAuthTestTempRoot(tempRoot);
    }
  });
});
