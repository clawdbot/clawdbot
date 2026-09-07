import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { inlineAuthProfileCredentialSchema } from "./credential-schema.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { refreshSerializedOAuthCredential } from "./oauth-refresh-fence.js";
import { createFailedOAuthRefreshFence, createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store-runtime.js";
import type { OAuthCredential } from "./types.js";

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

  it("rejects a late settlement after the exact credential generation is restored and reclaimed", async () => {
    const profileId = "openai:default";
    const firstCredential = createCredential({
      access: "first-access",
      refresh: "stable-refresh",
      expires: 1,
      accountId: "acct-123",
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
          accountId: "acct-123",
        }),
      })),
    ).resolves.toMatchObject({ apiKey: "second-rotated-access" });

    settleFirst?.({
      apiKey: "late-first-access",
      credential: createCredential({
        access: "late-first-access",
        refresh: "late-first-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
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
  ])("$name after a forced refresh failure", async ({ candidate, expectedApiKey }) => {
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
        buildApiKey: async (_provider, credential) => credential.access,
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
