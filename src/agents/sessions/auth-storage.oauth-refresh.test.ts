import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOAuthManager } from "../auth-profiles/oauth-manager.js";
import { refreshSerializedOAuthCredential } from "../auth-profiles/oauth-refresh-fence.js";
import {
  createOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../auth-profiles/oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import * as authProfileStoreRuntime from "../auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, type AuthStorageBackend } from "./auth-storage.js";

const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
}

async function expectSerializedProviderMismatch(params: {
  initial: OAuthCredential;
  beforeLock?: (call: number) => void;
  afterLock?: (call: number, setCredential: (credential: OAuthCredential) => void) => void;
  onCanRefresh?: (setCredential: (credential: OAuthCredential) => void) => void;
}): Promise<void> {
  const profileId = "openai:default";
  let persisted = JSON.stringify({ [profileId]: params.initial });
  let lockCalls = 0;
  const setCredential = (credential: OAuthCredential) => {
    persisted = JSON.stringify({ [profileId]: credential });
  };
  const backend = {
    withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
      lockCalls += 1;
      params.beforeLock?.(lockCalls);
      const update = fn(persisted);
      if (update.next !== undefined) {
        persisted = update.next;
      }
      params.afterLock?.(lockCalls, setCredential);
      return update.result;
    },
  };
  const refreshed = createCredential({
    provider: "provider-b",
    access: "provider-b-access",
    refresh: "provider-b-refresh",
    expires: Date.now() + 600_000,
    accountId: "acct-b",
  });
  const refresh = vi.fn(async () => ({ apiKey: refreshed.access, credential: refreshed }));
  const resolve = vi.fn(async (credential: OAuthCredential) => ({
    apiKey: credential.access,
    credential,
  }));

  await expect(
    refreshSerializedOAuthCredential({
      backend,
      provider: "openai",
      profileId,
      label: "test serialized provider ownership",
      timeoutMs: 1_000,
      parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
      serialize: JSON.stringify,
      readCredential: (data) => data[profileId],
      writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
      canRefresh: async () => {
        params.onCanRefresh?.(setCredential);
        return true;
      },
      refresh,
      resolve,
      commit: () => {},
    }),
  ).resolves.toBeNull();
  expect(refresh).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("AuthStorage OAuth refresh ownership", () => {
  it.each([
    { state: "fresh", expires: Date.now() + 600_000 },
    { state: "expired", expires: 1 },
    { state: "pending", expires: 1 },
  ])(
    "rejects an initial $state credential owned by another provider",
    async ({ state, expires }) => {
      await withOAuthTempRoot(`oauth-manager-provider-${state}-`, async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const attempted = createCredential({ expires: 1, accountId: "acct-a" });
        const providerB = createCredential({
          provider: "provider-b",
          access: "provider-b-access",
          refresh: "provider-b-refresh",
          expires,
          accountId: "acct-b",
        });
        const stored =
          state === "pending"
            ? createOAuthRefreshFence({ profileId, credential: providerB })
            : providerB;
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: stored } }, agentDir, {
          filterExternalAuthProfiles: false,
        });

        if (state === "pending") {
          const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
          let pendingReads = 0;
          vi.spyOn(
            authProfileStoreRuntime,
            "loadAuthProfileStoreWithoutExternalProfiles",
          ).mockImplementation((...args: Parameters<typeof originalLoad>) => {
            const store = originalLoad(...args);
            const credential = store.profiles[profileId];
            if (
              credential?.type === "oauth" &&
              credential.provider === "provider-b" &&
              isPendingOAuthRefreshFence(credential)
            ) {
              pendingReads += 1;
              if (pendingReads > 1) {
                throw new Error("provider-B fence must not be observed");
              }
            }
            return store;
          });
        }

        const buildApiKey = vi.fn(
          async (_provider, credential: OAuthCredential) => credential.access,
        );
        const refreshCredential = vi.fn(async () => providerB);
        const manager = createOAuthManager({
          buildApiKey,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        await expect(
          manager.resolveOAuthAccess({
            store: { version: 1, profiles: { [profileId]: attempted } },
            profileId,
            credential: attempted,
            agentDir,
          }),
        ).resolves.toBeNull();
        expect(buildApiKey).not.toHaveBeenCalled();
        expect(refreshCredential).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a provider change after an OAuth manager compare-and-swap miss", async () => {
    await withOAuthTempRoot("oauth-manager-provider-cas-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const attempted = createCredential({ expires: 1, accountId: "acct-a" });
      const providerB = createCredential({
        provider: "provider-b",
        access: "provider-b-access",
        refresh: "provider-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: attempted } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const buildApiKey = vi.fn(
        async (_provider, credential: OAuthCredential) => credential.access,
      );
      const refreshCredential = vi.fn(async () => providerB);
      const manager = createOAuthManager({
        buildApiKey,
        canRefreshCredential: async () => {
          saveAuthProfileStore({ version: 1, profiles: { [profileId]: providerB } }, agentDir, {
            filterExternalAuthProfiles: false,
          });
          return true;
        },
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: attempted,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(buildApiKey).not.toHaveBeenCalled();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(providerB);
    });
  });

  it("stops observing when an OAuth manager fence changes provider", async () => {
    await withOAuthTempRoot("oauth-manager-provider-observer-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const attempted = createCredential({ expires: 1, accountId: "acct-a" });
      const providerAFence = createOAuthRefreshFence({ profileId, credential: attempted });
      const providerB = createCredential({
        provider: "provider-b",
        access: "provider-b-access",
        refresh: "provider-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      });
      const providerBFence = createOAuthRefreshFence({ profileId, credential: providerB });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: providerAFence } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
      let providerAReads = 0;
      let providerBReads = 0;
      vi.spyOn(
        authProfileStoreRuntime,
        "loadAuthProfileStoreWithoutExternalProfiles",
      ).mockImplementation((...args: Parameters<typeof originalLoad>) => {
        const store = originalLoad(...args);
        const credential = store.profiles[profileId];
        if (credential?.type === "oauth" && credential.provider === "openai") {
          providerAReads += 1;
          if (providerAReads === 2) {
            saveAuthProfileStore(
              { version: 1, profiles: { [profileId]: providerBFence } },
              agentDir,
              { filterExternalAuthProfiles: false },
            );
          }
        } else if (
          credential?.type === "oauth" &&
          credential.provider === "provider-b" &&
          isPendingOAuthRefreshFence(credential)
        ) {
          providerBReads += 1;
          if (providerBReads > 1) {
            throw new Error("provider-B fence observation continued");
          }
        }
        return store;
      });
      const buildApiKey = vi.fn(
        async (_provider, credential: OAuthCredential) => credential.access,
      );
      const manager = createOAuthManager({
        buildApiKey,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => null),
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: { version: 1, profiles: { [profileId]: attempted } },
          profileId,
          credential: attempted,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(buildApiKey).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "fresh initial credential",
      initial: createCredential({ provider: "provider-b", expires: Date.now() + 600_000 }),
    },
    {
      name: "expired initial credential",
      initial: createCredential({ provider: "provider-b", expires: 1 }),
    },
    {
      name: "pending initial fence",
      initial: createOAuthRefreshFence({
        profileId: "openai:default",
        credential: createCredential({ provider: "provider-b", expires: 1 }),
      }),
      beforeLock: (call: number) => {
        if (call > 1) {
          throw new Error("provider-B fence must not be observed");
        }
      },
    },
    {
      name: "post-canRefresh replacement",
      initial: createCredential({ expires: 1 }),
      onCanRefresh: (setCredential: (credential: OAuthCredential) => void) =>
        setCredential(createCredential({ provider: "provider-b", expires: Date.now() + 600_000 })),
    },
    {
      name: "observer fence replacement",
      initial: createOAuthRefreshFence({
        profileId: "openai:default",
        credential: createCredential({ expires: 1 }),
      }),
      beforeLock: (call: number) => {
        if (call > 2) {
          throw new Error("provider-B fence observation continued");
        }
      },
      afterLock: (call: number, setCredential: (credential: OAuthCredential) => void) => {
        if (call === 1) {
          setCredential(
            createOAuthRefreshFence({
              profileId: "openai:default",
              credential: createCredential({ provider: "provider-b", expires: 1 }),
            }),
          );
        }
      },
    },
  ])("rejects a serialized provider change from a $name", async (scenario) => {
    await expectSerializedProviderMismatch(scenario);
  });

  it("normalizes a missing provider before serialized refresh", async () => {
    const providerId = "test-oauth";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
      },
    });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const refreshToken = vi.fn(async () => ({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 60_000,
    }));
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register({
      id: providerId,
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    });

    await expect(storage.getApiKey(providerId)).resolves.toBe("rotated-access");
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(JSON.parse(persisted)[providerId]).toMatchObject({
      type: "oauth",
      provider: providerId,
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("runs provider I/O outside custom backend locks and fences peer retries", async () => {
    const providerId = "test-oauth";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "claimed-access",
        refresh: "claimed-refresh",
        expires: 1,
        accountId: "acct-123",
      },
    });
    let lockDepth = 0;
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        expect(lockDepth).toBe(0);
        lockDepth += 1;
        try {
          const update = fn(persisted);
          if (update.next !== undefined) {
            persisted = update.next;
          }
          return update.result;
        } finally {
          lockDepth -= 1;
        }
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRefresh:
      | ((credentials: { access: string; refresh: string; expires: number }) => void)
      | undefined;
    const refreshToken = vi.fn(
      () =>
        new Promise<{ access: string; refresh: string; expires: number }>((resolve) => {
          expect(lockDepth).toBe(0);
          finishRefresh = resolve;
          markStarted?.();
        }),
    );
    const provider = {
      id: providerId,
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register(provider);

    const first = storage.getApiKey(providerId);
    await started;

    expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
    expect(persisted).not.toContain("claimed-access");
    expect(persisted).not.toContain("claimed-refresh");
    expect(storage.get(providerId)).toBeUndefined();
    expect(storage.has(providerId)).toBe(false);
    expect(storage.list()).not.toContain(providerId);
    expect(storage.getAll()).toEqual({});
    expect(storage.getAuthStatus(providerId)).toEqual({ configured: false });
    const peer = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(peer).register(provider);
    const peerResult = peer.getApiKey(providerId);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    finishRefresh?.({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 600_000,
    });
    await expect(first).resolves.toBe("rotated-access");
    await expect(peerResult).resolves.toBe("rotated-access");
    expect(JSON.parse(persisted)).toMatchObject({
      [providerId]: {
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      },
    });
  });

  it("preserves an expired credential when no refresh owner exists", async () => {
    const providerId = "unowned-oauth";
    const original = {
      type: "oauth",
      provider: providerId,
      access: "unowned-access",
      refresh: "unowned-refresh",
      expires: 1,
    } as const;
    let persisted = JSON.stringify({ [providerId]: original });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const storage = AuthStorage.fromStorage(backend);

    await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
    expect(JSON.parse(persisted)[providerId]).toEqual(original);
  });

  it("does not replay a failed generation and allows environment fallback after restart", async () => {
    const providerId = "xai";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "failed-access",
        refresh: "failed-refresh",
        expires: 1,
      },
    });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const refreshToken = vi.fn(async () => {
      throw new Error("simulated provider rejection");
    });
    const provider = {
      id: providerId,
      name: "Failed OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const first = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(first).register(provider);
    await expect(first.getApiKey(providerId)).resolves.toBeUndefined();

    vi.stubEnv("XAI_API_KEY", "environment-fallback");
    try {
      const restarted = AuthStorage.fromStorage(backend);
      getAuthStorageOAuthProviderRegistry(restarted).register(provider);
      await expect(restarted.getApiKey(providerId)).resolves.toBe("environment-fallback");
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
      expect(persisted).not.toContain("failed-access");
      expect(persisted).not.toContain("failed-refresh");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
