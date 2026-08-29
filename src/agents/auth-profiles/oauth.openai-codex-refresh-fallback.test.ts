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
import type { OpenClawConfig } from "../../config/config.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, resetFileLockStateForTest } from "../../infra/file-lock.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { buildRefreshContentionError } from "./oauth-refresh-lock-errors.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createExpiredOauthStore,
  readAuthProfileStoreForTest,
} from "./oauth-test-utils.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
  RuntimeAuthProfileStore,
} from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let refreshCodexCliOAuthCredentialForRuntime: typeof import("./oauth.js").refreshCodexCliOAuthCredentialForRuntime;
let resolveApiKeyForProviderCore: typeof import("../model-auth.js").resolveApiKeyForProviderCore;
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
    async (_params?: {
      config?: OpenClawConfig;
      context?: unknown;
    }): Promise<OAuthCredential | undefined> => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
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
  resolveProviderOAuthCredentialWithPlugin: async (params: {
    config?: OpenClawConfig;
    credential: OAuthCredential;
  }) => {
    const credential = await refreshProviderOAuthCredentialWithPluginMock({
      config: params.config,
      context: params.credential,
    });
    return credential
      ? { status: "available", credential, apiKey: credential.access }
      : { status: "unhandled" };
  },
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveExternalAuthProfilesWithPlugins: () => [],
  resolveProviderDeprecatedAuthProfileIds: () => [],
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

async function readPersistedStore(agentDir?: string): Promise<AuthProfileStore> {
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
  credential: AuthProfileCredential | undefined,
  metadata: Record<string, unknown> = {},
): void {
  expect(credential?.type).toBe("oauth");
  expect(credential?.provider).toBe("openai");
  for (const [key, value] of Object.entries(metadata)) {
    expect(credential?.[key as keyof typeof credential]).toBe(value);
  }
}

function createCodexCliRuntimeStore(
  profileId: string,
  credential: OAuthCredential,
): RuntimeAuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: credential },
    runtimeExternalProfileIds: [profileId],
    runtimeExternalCliProfileIds: [profileId],
  };
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
  const envSnapshot = captureEnv([...OAUTH_AGENT_ENV_KEYS, "OPENAI_API_KEY"]);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    ({ refreshCodexCliOAuthCredentialForRuntime, resolveApiKeyForProfile } =
      await import("./oauth.js"));
    ({ hasAvailableAuthForProvider, resolveApiKeyForProviderCore } =
      await import("../model-auth.js"));
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
    deleteTestEnvValue("OPENAI_API_KEY");
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

  it("promotes only a freshly reread changed Codex CLI rotation into SQLite", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    const freshNativeCredential = {
      ...nativeCredential,
      // Metadata-only changes do not prove that Codex replaced the bearer
      // rejected by app-server, so force-refresh must still call the provider.
      expires: Date.now() + 10 * 60_000,
    };
    readCodexCliCredentialsCachedMock.mockReturnValue(freshNativeCredential);
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async (params) => {
      expect(requireOAuthContext(params?.context).access).toBe("native-access");
      return {
        ...freshNativeCredential,
        access: "rotated-access-token",
        refresh: "rotated-refresh-token",
        expires: Date.now() + 86_400_000,
      };
    });

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
    });

    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledWith({
      allowKeychainPrompt: false,
      ttlMs: 0,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expectPersistedOpenAICodexProfile((await readPersistedStore()).profiles[profileId], {
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
    });
    expect(store.runtimeExternalCliProfileIds).toBeUndefined();
    expect(store.runtimeExternalProfileIds).toBeUndefined();
    expect(store.runtimePersistedProfileIds).toEqual([profileId]);
  });

  it("promotes one native rotation for distinct agent owners and prepared callers", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const createPreparedStore = () =>
      createCodexCliRuntimeStore(profileId, { ...nativeCredential });
    const firstStore = createPreparedStore();
    const secondStore = createPreparedStore();
    expect(secondStore).not.toBe(firstStore);
    const stateRoot = path.resolve(agentDir, "../../..");
    const firstAgentDir = path.join(stateRoot, "agents", "worker-a", "agent");
    const secondAgentDir = path.join(stateRoot, "agents", "worker-b", "agent");
    await Promise.all([
      fs.mkdir(firstAgentDir, { recursive: true }),
      fs.mkdir(secondAgentDir, { recursive: true }),
    ]);
    readCodexCliCredentialsCachedMock.mockReturnValue({ ...nativeCredential });
    const firstRefresh: { resolve?: (credential: OAuthCredential) => void } = {};
    const firstRefreshResult = new Promise<OAuthCredential>((resolve) => {
      firstRefresh.resolve = resolve;
    });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () => await firstRefreshResult,
    );

    const first = refreshCodexCliOAuthCredentialForRuntime({
      store: firstStore,
      profileId,
      agentDir: firstAgentDir,
      forceRefresh: true,
    });
    await vi.waitFor(() =>
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1),
    );
    const second = refreshCodexCliOAuthCredentialForRuntime({
      store: secondStore,
      profileId,
      agentDir: secondAgentDir,
      forceRefresh: true,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);

    expectDefined(
      firstRefresh.resolve,
      "first refresh resolver test invariant",
    )({
      ...nativeCredential,
      access: "first-rotated-access",
      refresh: "first-rotated-refresh",
      expires: Date.now() + 10 * 60_000,
    });
    await expect(first).resolves.toMatchObject({ refresh: "first-rotated-refresh" });
    await expect(second).resolves.toMatchObject({ refresh: "first-rotated-refresh" });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(readCodexCliCredentialsCachedMock).toHaveBeenCalledTimes(1);
    expectPersistedOpenAICodexProfile((await readPersistedStore()).profiles[profileId], {
      refresh: "first-rotated-refresh",
    });
    expect((await readPersistedStore(firstAgentDir)).profiles[profileId]).toBeUndefined();
    expect((await readPersistedStore(secondAgentDir)).profiles[profileId]).toBeUndefined();
    expect(firstStore.runtimePersistedProfileIds).toEqual([profileId]);
    expect(secondStore.runtimePersistedProfileIds).toEqual([profileId]);
  });

  it("rotates again when the current SQLite credential is the rejected attempt", async () => {
    const profileId = "openai:default";
    const currentCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "current-access",
      refresh: "current-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "acct-native",
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: currentCredential } }, agentDir);
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async (params) => {
      expect(requireOAuthContext(params?.context).refresh).toBe("current-refresh");
      return {
        ...currentCredential,
        access: "next-access",
        refresh: "next-refresh",
        expires: Date.now() + 20 * 60_000,
      };
    });
    const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });

    await expect(
      resolveApiKeyForProfile({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ apiKey: "next-access" });

    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expectPersistedOpenAICodexProfile((await readPersistedStore(agentDir)).profiles[profileId], {
      access: "next-access",
      refresh: "next-refresh",
    });
  });

  it("does not persist an unchanged native Codex CLI refresh result", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    readCodexCliCredentialsCachedMock.mockReturnValue({ ...nativeCredential });
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({ ...nativeCredential });

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ refresh: "native-refresh" });

    expect((await readPersistedStore(agentDir)).profiles[profileId]).toBeUndefined();
    expect(store.runtimeExternalCliProfileIds).toEqual([profileId]);
  });

  it("adopts a usable fresh native reread without provider rotation or SQLite promotion", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "prepared-access",
      refresh: "prepared-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-prepared",
    };
    const freshCredential: OAuthCredential = {
      ...nativeCredential,
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "acct-fresh-login",
    };
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    readCodexCliCredentialsCachedMock.mockReturnValue(freshCredential);

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({
      access: "fresh-access",
      refresh: "fresh-refresh",
      accountId: "acct-fresh-login",
    });

    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect((await readPersistedStore(agentDir)).profiles[profileId]).toBeUndefined();
    expect(store.runtimeExternalCliProfileIds).toEqual([profileId]);
  });

  it("rejects an expired fresh native reread with a different identity before rotation", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "prepared-access",
      refresh: "prepared-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-prepared",
    };
    readCodexCliCredentialsCachedMock.mockReturnValue({
      ...nativeCredential,
      access: "fresh-access",
      refresh: "fresh-refresh",
      accountId: "acct-fresh-login",
    });

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store: createCodexCliRuntimeStore(profileId, nativeCredential),
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect((await readPersistedStore(agentDir)).profiles[profileId]).toBeUndefined();
  });

  it("does not promote arbitrary supplied OAuth without Codex CLI provenance", async () => {
    const profileId = "openai:default";
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "supplied-access",
      refresh: "supplied-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-supplied",
    };

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store: { version: 1, profiles: { [profileId]: credential } },
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect((await readPersistedStore(agentDir)).profiles[profileId]).toBeUndefined();
  });

  it("commits the rotated token when a same-identity SQLite row wins the insert race", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    readCodexCliCredentialsCachedMock.mockReturnValue({ ...nativeCredential });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              ...nativeCredential,
              access: "racing-access",
              refresh: "native-refresh",
            },
          },
        },
        agentDir,
      );
      return {
        ...nativeCredential,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      };
    });

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ refresh: "rotated-refresh" });

    expectPersistedOpenAICodexProfile((await readPersistedStore(agentDir)).profiles[profileId], {
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("adopts a usable different-identity SQLite relog that wins the insert race", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    readCodexCliCredentialsCachedMock.mockReturnValue({ ...nativeCredential });
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "relogin-access",
              refresh: "relogin-refresh",
              expires: Date.now() + 10 * 60_000,
              accountId: "acct-relogin",
            },
          },
        },
        agentDir,
      );
      return {
        ...nativeCredential,
        access: "rotated-native-access",
        refresh: "rotated-native-refresh",
        expires: Date.now() + 60_000,
      };
    });

    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({
      access: "relogin-access",
      refresh: "relogin-refresh",
      accountId: "acct-relogin",
    });
    expectPersistedOpenAICodexProfile((await readPersistedStore(agentDir)).profiles[profileId], {
      refresh: "relogin-refresh",
      accountId: "acct-relogin",
    });
  });

  it("adopts usable authoritative SQLite despite a stale native prepared identity", async () => {
    const profileId = "openai:default";
    const nativeCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "native-access",
      refresh: "native-refresh",
      expires: Date.now() - 60_000,
      accountId: "acct-native",
    };
    const managedCredential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "managed-access",
      refresh: "managed-refresh",
      expires: Date.now() + 10 * 60_000,
      accountId: "acct-relogin",
    };
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: managedCredential } }, agentDir);
    const store = createCodexCliRuntimeStore(profileId, nativeCredential);
    await expect(
      refreshCodexCliOAuthCredentialForRuntime({
        store,
        profileId,
        agentDir,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({ refresh: "managed-refresh" });

    expect(readCodexCliCredentialsCachedMock).not.toHaveBeenCalled();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expectPersistedOpenAICodexProfile((await readPersistedStore(agentDir)).profiles[profileId], {
      refresh: "managed-refresh",
    });
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

  it("never refreshes a retired Claude CLI token as a legacy-profile fallback", async () => {
    const legacyProfileId = "anthropic:default";
    const retiredProfileId = "anthropic:claude-cli";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [legacyProfileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "expired-default-access",
            refresh: "expired-default-refresh",
            expires: Date.now() - 60_000,
          },
          [retiredProfileId]: {
            type: "oauth",
            provider: "anthropic",
            access: "copied-native-access",
            refresh: "copied-native-refresh",
            expires: Date.now() - 60_000,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    refreshProviderOAuthCredentialWithPluginMock
      .mockRejectedValueOnce(new Error("initial refresh failed"))
      .mockResolvedValueOnce({
        type: "oauth",
        provider: "anthropic",
        access: "refreshed-copied-native-access",
        refresh: "refreshed-copied-native-refresh",
        expires: Date.now() + 60 * 60_000,
      });

    await expect(
      resolveApiKeyForProfile({
        cfg: {
          auth: {
            profiles: {
              [legacyProfileId]: { provider: "anthropic", mode: "oauth" },
              [retiredProfileId]: { provider: "anthropic", mode: "oauth" },
            },
          },
        },
        store: ensureAuthProfileStore(agentDir),
        profileId: legacyProfileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when provider refresh returns an unchanged expired credential", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai",
      }),
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async (params) =>
      requireOAuthContext(params?.context),
    );

    await expect(resolveOpenAICodexProfile({ profileId, agentDir })).rejects.toThrow(
      /OAuth token refresh failed for openai/,
    );
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
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

  it("keeps configured provider context available during in-lock refresh", async () => {
    const profileId = "openai:default";
    const cfg = {
      auth: {
        profiles: {
          [profileId]: { provider: "openai", mode: "oauth" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://configured-openai.example.test/v1",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider: "openai" }), agentDir);
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async (params) =>
      params?.config === cfg
        ? {
            type: "oauth",
            provider: "openai",
            access: "configured-access-token",
            refresh: "configured-refresh-token",
            expires: Date.now() + 86_400_000,
          }
        : undefined,
    );

    await expect(
      resolveApiKeyForProfile({
        cfg,
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).resolves.toMatchObject({
      apiKey: "configured-access-token",
      provider: "openai",
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledWith({
      config: cfg,
      context: expect.objectContaining({
        provider: "openai",
        type: "oauth",
      }),
    });
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
      resolveApiKeyForProviderCore({
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
      resolveApiKeyForProviderCore({
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
      resolveApiKeyForProviderCore({
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
      resolveApiKeyForProviderCore({
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

  it("preserves the OAuth diagnosis when stale lastGood cleanup fails", async () => {
    const profileId = "openai:default";
    saveAuthProfileStore(
      {
        ...createExpiredOauthStore({ profileId, provider: "openai" }),
        lastGood: { openai: profileId },
      },
      agentDir,
    );
    const store = ensureAuthProfileStore(agentDir);
    openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveAuthProfileDatabasePath(agentDir),
    }).db.exec("ALTER TABLE auth_profile_state DROP COLUMN updated_at");
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    const failure = await resolveApiKeyForProfile({ store, profileId, agentDir }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(String(failure)).toContain("refresh_token_reused");
    expect(String(failure)).not.toContain("no column named updated_at");
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

    const resolved = await resolveApiKeyForProviderCore({
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
