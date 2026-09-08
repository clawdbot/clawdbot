import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { inlineAuthProfileCredentialSchema } from "./credential-schema.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import { refreshSerializedOAuthCredential } from "./oauth-refresh-fence.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as authProfileStoreRuntime from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

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

afterEach(async () => {
  vi.restoreAllMocks();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("OAuth refresh generation fence", () => {
  it("keeps serialized provider I/O outside locks and settles after observer timeout", async () => {
    const profileId = "openai:default";
    const expired = createCredential({
      access: "serialized-access",
      refresh: "serialized-refresh",
      expires: 1,
      accountId: "acct-123",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    let lockDepth = 0;
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
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
    };
    let finish: ((result: { apiKey: string; credential: OAuthCredential }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const refresh = vi.fn(
      () =>
        new Promise<{ apiKey: string; credential: OAuthCredential }>((resolve) => {
          expect(lockDepth).toBe(0);
          finish = resolve;
          markStarted?.();
        }),
    );
    const run = async (
      refreshOwner: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      await refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized refresh",
        timeoutMs: 10,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: refreshOwner,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    const first = run(refresh);
    await started;
    expect(JSON.parse(persisted)[profileId].access).toMatch(
      /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
    );
    await expect(first).rejects.toThrow("exceeded hard timeout");
    const peerRefresh = vi.fn(async () => null);
    const peer = run(peerRefresh);
    expect(peerRefresh).not.toHaveBeenCalled();

    finish?.({
      apiKey: "serialized-rotated-access",
      credential: createCredential({
        access: "serialized-rotated-access",
        refresh: "serialized-rotated-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      }),
    });
    await expect(peer).resolves.toMatchObject({ apiKey: "serialized-rotated-access" });
    await vi.waitFor(() => {
      expect(JSON.parse(persisted)[profileId]).toMatchObject({
        access: "serialized-rotated-access",
        refresh: "serialized-rotated-refresh",
      });
    });
  });

  it("rejects a different-account replacement for serialized owner and observer settlement", async () => {
    const profileId = "openai:default";
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    let finish: ((result: { apiKey: string; credential: OAuthCredential }) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const refresh = vi.fn(
      () =>
        new Promise<{ apiKey: string; credential: OAuthCredential }>((resolve) => {
          finish = resolve;
          markStarted?.();
        }),
    );
    const run = (
      refreshOwner: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized identity replacement",
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: refreshOwner,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    const owner = run(refresh);
    await started;
    const peerRefresh = vi.fn(async () => null);
    const observer = run(peerRefresh);
    persisted = JSON.stringify({
      [profileId]: createCredential({
        access: "account-b-access",
        refresh: "account-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      }),
    });

    await expect(observer).resolves.toBeNull();
    finish?.({
      apiKey: "rotated-a-access",
      credential: createCredential({
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-a",
      }),
    });
    await expect(owner).rejects.toThrow("owner changed");
    expect(refresh).toHaveBeenCalledOnce();
    expect(peerRefresh).not.toHaveBeenCalled();
    expect(JSON.parse(persisted)[profileId]).toMatchObject({
      access: "account-b-access",
      refresh: "account-b-refresh",
      accountId: "acct-b",
    });
  });

  it("terminally fences invalid serialized provider outcomes", async () => {
    const profileId = "openai:default";
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const run = (refresh: () => Promise<{ apiKey: string; credential: OAuthCredential } | null>) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized provider identity mismatch",
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    await expect(
      run(async () => ({
        apiKey: "account-b-access",
        credential: createCredential({
          access: "account-b-access",
          refresh: "account-b-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-b",
        }),
      })),
    ).rejects.toThrow("different OAuth account");

    let stored = JSON.parse(persisted)[profileId] as OAuthCredential;
    expect(stored).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct-a",
      expires: 1,
    });
    expect(stored.access).toContain(":failed:access:");
    expect(JSON.stringify(stored)).not.toContain("account-b-access");

    for (const providerRejection of [{ reason: "invalid_grant", status: 401 }, undefined]) {
      persisted = JSON.stringify({ [profileId]: expired });
      // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
      const failure = await run(() => Promise.reject(providerRejection)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: "OAuth refresh failed", cause: providerRejection });
      if (providerRejection) {
        expect(failure).toMatchObject(providerRejection);
      }
      stored = JSON.parse(persisted)[profileId] as OAuthCredential;
      expect(isPendingOAuthRefreshFence(stored)).toBe(false);
      expect(stored.access).toContain(":failed:access:");
    }
  });

  it.each([{ outcome: "throw" as const }, { outcome: "null" as const }])(
    "surfaces one failed serialized terminal write after a $outcome refresh",
    async ({ outcome }) => {
      const profileId = "openai:default";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "acct-123",
      });
      let persisted = JSON.stringify({ [profileId]: expired });
      let lockDepth = 0;
      let terminalAttempts = 0;
      const terminalError = new Error("failed to persist serialized terminal fence");
      const backend = {
        withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
          expect(lockDepth).toBe(0);
          lockDepth += 1;
          try {
            const update = fn(persisted);
            if (update.next?.includes(":failed:access:")) {
              terminalAttempts += 1;
              throw terminalError;
            }
            if (update.next !== undefined) {
              persisted = update.next;
            }
            return update.result;
          } finally {
            lockDepth -= 1;
          }
        },
      };
      const initiatingError = new Error("provider refresh failed");
      const run = refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: `test serialized ${outcome} terminal failure`,
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: async () => {
          if (outcome === "throw") {
            throw initiatingError;
          }
          return null;
        },
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

      if (outcome === "throw") {
        await expect(run).rejects.toSatisfy((caught: unknown) => {
          expect(caught).toBeInstanceOf(AggregateError);
          const aggregate = caught as AggregateError;
          expect(aggregate.errors).toEqual([initiatingError, terminalError]);
          expect(aggregate.cause).toBe(initiatingError);
          return true;
        });
      } else {
        await expect(run).rejects.toBe(terminalError);
      }
      expect(terminalAttempts).toBe(1);
      expect(lockDepth).toBe(0);
      expect(backend.withLock(() => ({ result: "reacquired" }))).toBe("reacquired");
    },
  );

  it("rejects a manager provider refresh result for a different OAuth account", async () => {
    await withOAuthTempRoot("oauth-manager-provider-account-mismatch-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "account-a-access",
        refresh: "account-a-refresh",
        expires: 1,
        accountId: "acct-a",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () =>
          createCredential({
            access: "account-b-access",
            refresh: "account-b-refresh",
            expires: Date.now() + 600_000,
            accountId: "acct-b",
          }),
        ),
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).rejects.toThrow("different OAuth account");
      const persisted = ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
      expect(persisted).toMatchObject({ accountId: "acct-a", expires: 1 });
      expect(persisted?.type === "oauth" ? persisted.access : "").toContain(":failed:access:");
      expect(JSON.stringify(persisted)).not.toContain("account-b-access");
    });
  });

  it.each([{ outcome: "throw" as const }, { outcome: "null" as const }])(
    "surfaces one failed manager terminal write after a $outcome refresh",
    async ({ outcome }) => {
      await withOAuthTempRoot(`oauth-manager-${outcome}-terminal-failure-`, async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const expired = createCredential({
          access: "expired-access",
          refresh: "expired-refresh",
          expires: 1,
          accountId: "acct-123",
        });
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
          filterExternalAuthProfiles: false,
        });
        const initiatingError = Object.assign(new Error("provider rejected invalid_grant"), {
          oauthRefreshFailure: {
            errorType: "invalid_grant_error",
            reason: "invalid_grant",
            status: 401,
            summary: "provider rejected invalid_grant",
          },
        });
        const originalUpdate = authProfileStoreRuntime.updateAuthProfileStoreWithLock;
        let terminalAttempts = 0;
        vi.spyOn(authProfileStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation(
          async (params) => {
            const current =
              ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
            if (current?.type === "oauth" && isPendingOAuthRefreshFence(current)) {
              terminalAttempts += 1;
              return null;
            }
            return await originalUpdate(params);
          },
        );
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          canRefreshCredential: async () => true,
          refreshCredential: vi.fn(async () => {
            if (outcome === "throw") {
              throw initiatingError;
            }
            return null;
          }),
          readBootstrapCredential: () => null,
        });

        let caught: unknown;
        try {
          await manager.resolveOAuthAccess({
            store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
            profileId,
            credential: expired,
            agentDir,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
        const refreshError = caught as OAuthManagerRefreshError;
        if (outcome === "throw") {
          expect(refreshError.reason).toBe("invalid_grant");
          expect(refreshError.cause).toBeInstanceOf(AggregateError);
          const aggregate = refreshError.cause as AggregateError;
          expect(formatErrorMessage(aggregate.errors[0])).toContain("invalid_grant");
          expect(formatErrorMessage(aggregate.errors[1])).toContain("terminal OAuth refresh fence");
          expect(aggregate.cause).toBe(aggregate.errors[0]);
        } else {
          expect(refreshError.message).toContain("terminal OAuth refresh fence");
        }
        expect(terminalAttempts).toBe(1);
        await expect(
          withOAuthProfileLock({ provider: "openai", profileId }, async () => "reacquired"),
        ).resolves.toBe("reacquired");
      });
    },
  );

  it("rejects a different-account login while an owner and observer settle account A", async () => {
    await withOAuthTempRoot("openclaw-oauth-account-replacement-", async () => {
      const profileId = "openai:default";
      const original = createCredential({
        access: "account-a-access",
        refresh: "account-a-refresh",
        expires: 1,
        accountId: "acct-a",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: original } }, undefined);

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
        return createCredential({
          access: "rotated-a-access",
          refresh: "rotated-a-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-a",
        });
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
      let watchObserverReads = false;
      let markObserverReadFence: (() => void) | undefined;
      const observerReadFence = new Promise<void>((resolve) => {
        markObserverReadFence = resolve;
      });
      const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
      const loadSpy = vi
        .spyOn(authProfileStoreRuntime, "loadAuthProfileStoreWithoutExternalProfiles")
        .mockImplementation((...args: Parameters<typeof originalLoad>) => {
          const store = originalLoad(...args);
          const credential = store.profiles[profileId];
          if (
            watchObserverReads &&
            credential?.type === "oauth" &&
            isPendingOAuthRefreshFence(credential)
          ) {
            markObserverReadFence?.();
          }
          return store;
        });

      const owner = createManager().resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(undefined),
        profileId,
        credential: original,
      });
      await refreshStarted;
      let markObserverEntered: (() => void) | undefined;
      const observerEntered = new Promise<void>((resolve) => {
        markObserverEntered = resolve;
      });
      watchObserverReads = true;
      const observer = createManager(markObserverEntered).resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(undefined),
        profileId,
        credential: original,
      });
      await observerEntered;
      await observerReadFence;
      watchObserverReads = false;
      const relogin = persistAuthProfileBatch({
        profiles: [
          {
            profileId,
            credential: createCredential({
              access: "account-b-access",
              refresh: "account-b-refresh",
              expires: Date.now() + 600_000,
              accountId: "acct-b",
            }),
          },
        ],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      });
      await relogin;

      await expect(observer).resolves.toBeNull();
      finishRefresh?.();
      await expect(owner).rejects.toThrow("OAuth token refresh failed");
      expect(refreshCredential).toHaveBeenCalledOnce();
      expect(loadPersistedAuthProfileStore(undefined)?.profiles[profileId]).toMatchObject({
        access: "account-b-access",
        refresh: "account-b-refresh",
        accountId: "acct-b",
      });
      loadSpy.mockRestore();
    });
  });

  it("persists before provider I/O and prevents replay", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-fence-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const expired = createCredential({
        access: "claimed-access",
        refresh: "claimed-refresh",
        idToken: "claimed-id-token",
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
          id: "0123456789abcdef0123456789abcdef",
        },
        expires: 1,
        accountId: "acct-123",
        email: "user@example.test",
        displayName: "Example User",
        chatgptPlanType: "plus",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      let finishRefresh: ((credential: OAuthCredential) => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const refreshCredential = vi.fn(
        (credential: OAuthCredential) =>
          new Promise<OAuthCredential>((resolve) => {
            expect(credential).toEqual(expired);
            finishRefresh = resolve;
            markStarted?.();
          }),
      );
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      const first = manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: expired,
        agentDir,
      });
      await started;

      const fenced = ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
      expect(fenced).toMatchObject({
        type: "oauth",
        provider: "openai",
        expires: 1,
        accountId: "acct-123",
        email: "user@example.test",
        displayName: "Example User",
        chatgptPlanType: "plus",
      });
      if (fenced?.type !== "oauth") {
        throw new Error("expected fenced OAuth credential");
      }
      expect(fenced.access).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
      );
      expect(fenced.refresh).toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
      );
      expect(fenced.idToken).toBeUndefined();
      expect(fenced.oauthRef).toBeUndefined();
      expect(JSON.stringify(fenced)).not.toContain("claimed-access");
      expect(JSON.stringify(fenced)).not.toContain("claimed-refresh");
      expect(JSON.stringify(fenced)).not.toContain("claimed-id-token");
      expect(inlineAuthProfileCredentialSchema.parse(fenced)).toEqual(fenced);

      const restartedRefresh = vi.fn(async () => {
        throw new Error("restarted manager must not replay the fenced generation");
      });
      const restartedManager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential: restartedRefresh,
        readBootstrapCredential: () => null,
      });
      const restarted = restartedManager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: expired,
        agentDir,
      });
      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(restartedRefresh).not.toHaveBeenCalled();

      finishRefresh?.(
        createCredential({
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-123",
        }),
      );
      await expect(first).resolves.toMatchObject({ apiKey: "rotated-access" });
      await expect(restarted).resolves.toMatchObject({ apiKey: "rotated-access" });
      expect(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
      ).toMatchObject({
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      });
    });
  });

  it("preserves the original credential when no refresh owner exists", async () => {
    await withOAuthTempRoot("oauth-manager-refresh-unowned-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "unowned:default";
      const expired = createCredential({
        provider: "unowned",
        access: "unowned-access",
        refresh: "unowned-refresh",
        expires: 1,
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: expired } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const refreshCredential = vi.fn(async () => null);
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => false,
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: expired,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
        expired,
      );
    });
  });

  it("rejects a late settlement after an identity-less generation is restored and reclaimed", async () => {
    const profileId = "openai:default";
    const firstCredential = createCredential({
      access: "first-access",
      refresh: "stable-refresh",
      expires: 1,
    });
    let persisted = JSON.stringify({ [profileId]: firstCredential });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const run = (
      refresh: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test ABA refresh",
        timeoutMs: 10,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });
    let settleFirst:
      | ((result: { apiKey: string; credential: OAuthCredential }) => void)
      | undefined;
    const first = run(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    await expect(first).rejects.toThrow("exceeded hard timeout");

    persisted = JSON.stringify({ [profileId]: firstCredential });
    await expect(
      run(async () => ({
        apiKey: "second-rotated-access",
        credential: createCredential({
          access: "second-rotated-access",
          refresh: "second-rotated-refresh",
          expires: Date.now() + 600_000,
        }),
      })),
    ).resolves.toMatchObject({ apiKey: "second-rotated-access" });

    settleFirst?.({
      apiKey: "late-first-access",
      credential: createCredential({
        access: "late-first-access",
        refresh: "late-first-refresh",
        expires: Date.now() + 600_000,
      }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(JSON.parse(persisted)[profileId]).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
  });

  it("does not replace a terminal fence from an unordered external generation", async () => {
    await withOAuthTempRoot("oauth-manager-fence-recovery-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:default";
      const fence = createFailedOAuthRefreshFence(
        createOAuthRefreshFence({
          profileId,
          credential: createCredential({
            access: "claimed-access",
            refresh: "claimed-refresh",
            expires: 1,
            accountId: "acct-123",
          }),
        }),
      );
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const recovered = createCredential({
        access: "recovered-access",
        refresh: "recovered-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      });
      const refreshCredential = vi.fn(async () => null);
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        canRefreshCredential: async () => true,
        refreshCredential,
        readBootstrapCredential: () => recovered,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: fence,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
        fence,
      );
    });
  });

  it.each([
    {
      name: "rejects refresh-only changes",
      candidate: {
        access: "failed-access",
        refresh: "new-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      },
      expectedApiKey: undefined,
    },
    {
      name: "adopts access-token changes",
      candidate: {
        access: "new-access",
        refresh: "failed-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      },
      expectedApiKey: "new-access",
    },
    {
      name: "preserves the refresh error when adopted-key construction fails",
      candidate: {
        access: "new-access",
        refresh: "failed-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      },
      expectedApiKey: undefined,
      buildError: "fallback key construction failed",
    },
  ])("$name after a forced refresh failure", async ({ candidate, expectedApiKey, buildError }) => {
    await withOAuthTempRoot("oauth-manager-force-fallback-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const supplied = createCredential({
        access: "failed-access",
        refresh: "failed-refresh",
        accountId: "acct-123",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: supplied } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => {
          if (buildError && credential.access === candidate.access) {
            throw new Error(buildError);
          }
          return credential.access;
        },
        canRefreshCredential: async () => true,
        refreshCredential: async () => {
          saveAuthProfileStore(
            {
              version: 1,
              profiles: { [profileId]: createCredential(candidate) },
            },
            agentDir,
            { filterExternalAuthProfiles: false },
          );
          throw new Error("forced refresh failed");
        },
        readBootstrapCredential: () => null,
      });
      const resolution = manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
        profileId,
        credential: supplied,
        agentDir,
        forceRefresh: true,
      });

      if (expectedApiKey) {
        await expect(resolution).resolves.toMatchObject({ apiKey: expectedApiKey });
      } else if (buildError) {
        await expect(resolution).rejects.toSatisfy((caught: unknown) => {
          expect(caught).toBeInstanceOf(OAuthManagerRefreshError);
          const error = caught as OAuthManagerRefreshError;
          expect(error.message).toContain("forced refresh failed");
          expect(error.cause).toBeInstanceOf(AggregateError);
          expect((error.cause as AggregateError).errors.map(formatErrorMessage)).toEqual([
            "forced refresh failed",
            buildError,
          ]);
          return true;
        });
      } else {
        await expect(resolution).rejects.toThrow("OAuth token refresh failed");
      }
    });
  });

  it.each([
    { name: "access changed", change: "access", expectedCalls: 0 },
    { name: "refresh changed", change: "refresh", expectedCalls: 1 },
    { name: "only expiry changed", change: "expires", expectedCalls: 1 },
  ] as const)(
    "checks authoritative $name before forced provider I/O",
    async ({ change, expectedCalls }) => {
      await withOAuthTempRoot("oauth-manager-force-authoritative-", async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const supplied = createCredential({
          access: "supplied-access",
          refresh: "supplied-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-123",
        });
        const live = createCredential({
          ...supplied,
          ...(change === "access" ? { access: "live-access" } : {}),
          ...(change === "refresh" ? { refresh: "live-refresh" } : {}),
          ...(change === "expires" ? { expires: supplied.expires + 600_000 } : {}),
        });
        const staleStore = { version: 1 as const, profiles: { [profileId]: supplied } };
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: live } }, agentDir, {
          filterExternalAuthProfiles: false,
        });
        const refreshCredential = vi.fn(async (credential: OAuthCredential) => {
          expect(credential).toEqual(live);
          return createCredential({
            ...credential,
            access: "provider-rotated-access",
            refresh: "provider-rotated-refresh",
            expires: Date.now() + 600_000,
          });
        });
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        await expect(
          manager.resolveOAuthAccess({
            store: staleStore,
            profileId,
            credential: supplied,
            agentDir,
            forceRefresh: true,
          }),
        ).resolves.toMatchObject({
          apiKey: expectedCalls === 0 ? "live-access" : "provider-rotated-access",
        });
        expect(refreshCredential).toHaveBeenCalledTimes(expectedCalls);
      });
    },
  );
});
