/**
 * Tests auth profile mutation helpers.
 * Covers locked upserts, order promotion, last-good clearing, legacy OAuth file
 * imports, and credential normalization.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOAuthDir } from "../../config/paths.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { testing as externalAuthTesting } from "./external-auth.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  clearLastGoodProfileWithLock,
  promoteAuthProfileInOrder,
  removeAuthProfilesWithLock,
  upsertAuthProfileWithLock,
} from "./profiles.js";
import {
  getRuntimeAuthProfileStoreSnapshot as getInternalRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreCredentialMutationRevision,
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreStateMutationRevision,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, runAuthProfileWriteTransaction } from "./sqlite.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  getRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
  restoreAuthProfileStorePersistenceSnapshot,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  saveAuthProfileStore,
  testing as storeTesting,
} from "./store.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

type ExpectedOAuthCredentialFields = {
  provider: string;
  access?: string;
  refresh?: string;
  idToken?: string;
  expires?: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

type AuthProfileTestState = {
  stateDir: string;
  agentDir: string;
  agentDirFor: (agentId: string) => string;
};

afterEach(() => {
  storeTesting.resetRuntimeSnapshotPublisherForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

async function withAuthProfileTestState<T>(
  prefix: string,
  run: (state: AuthProfileTestState) => Promise<T> | T,
  options: { clearOAuthDir?: boolean } = {},
): Promise<T> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDirFor = (agentId: string) => path.join(stateDir, "agents", agentId, "agent");
  try {
    return await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        ...(options.clearOAuthDir ? { OPENCLAW_OAUTH_DIR: undefined } : {}),
      },
      async () =>
        await run({
          stateDir,
          agentDir: agentDirFor("main"),
          agentDirFor,
        }),
    );
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function expectOAuthCredentialFields(
  value: unknown,
  expected: ExpectedOAuthCredentialFields,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected OAuth credential object");
  }
  const credential = value as Record<string, unknown>;
  expect(credential.type).toBe("oauth");
  expect(credential.provider).toBe(expected.provider);
  for (const field of [
    "access",
    "refresh",
    "idToken",
    "expires",
    "email",
    "accountId",
    "chatgptPlanType",
  ] as const) {
    if (field in expected) {
      expect(credential[field]).toBe(expected[field]);
    }
  }
  return credential;
}

describe("promoteAuthProfileInOrder", () => {
  it("refreshes inherited main selection state without advancing credential ownership", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-main-selection-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        const mainStore = (selected: string): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:first": {
              type: "api_key",
              provider: "openai",
              key: "sk-first",
            },
            "openai:second": {
              type: "api_key",
              provider: "openai",
              key: "sk-second",
            },
          },
          order: { openai: [selected] },
        });
        saveAuthProfileStore(mainStore("openai:first"));
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: customAgentDir,
            store: loadAuthProfileStoreForRuntime(customAgentDir),
          },
        ]);
        const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();

        saveAuthProfileStore(mainStore("openai:second"));

        expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialsRevision);
        expect(getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.order?.openai).toEqual([
          "openai:second",
        ]);
      },
      { clearOAuthDir: true },
    );
  });

  it("rebuilds a derived custom-agent snapshot after locked main OAuth rotation", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-main-inheritance-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        const mainStore = (access: string): AuthProfileStore => ({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access,
              refresh: `refresh-${access}`,
              expires: Date.now() + 60_000,
            },
          },
        });
        saveAuthProfileStore(mainStore("old"));
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "anthropic:custom": {
                type: "api_key",
                provider: "anthropic",
                keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
                key: "sk-custom-resolved",
              },
            },
          },
          customAgentDir,
        );
        const derivedStore = loadAuthProfileStoreForRuntime(customAgentDir);
        const customCredential = derivedStore.profiles["anthropic:custom"];
        if (customCredential?.type !== "api_key") {
          throw new Error("expected custom API-key profile");
        }
        customCredential.key = "sk-custom-resolved";
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: customAgentDir,
            store: derivedStore,
          },
        ]);
        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:default"],
        ).toMatchObject({ access: "old" });

        await upsertAuthProfileWithLock({
          profileId: "openai:default",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "new",
            refresh: "refresh-new",
            expires: Date.now() + 60_000,
          },
        });

        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:default"],
        ).toMatchObject({ access: "new", refresh: "refresh-new" });
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles(customAgentDir).profiles[
            "anthropic:custom"
          ],
        ).toMatchObject({
          key: "sk-custom-resolved",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("keeps inherited resolved credentials when publishing a locked custom-agent save", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-custom-publication-",
      async ({ agentDirFor }) => {
        const customAgentDir = agentDirFor("custom");
        fs.mkdirSync(customAgentDir, { recursive: true });
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "anthropic:inherited": {
              type: "api_key",
              provider: "anthropic",
              keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
            },
          },
        });
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:local": {
                type: "oauth",
                provider: "openai",
                access: "local-old",
                refresh: "local-refresh-old",
                expires: Date.now() + 60_000,
              },
            },
          },
          customAgentDir,
        );
        const runtimeStore = loadAuthProfileStoreForRuntime(customAgentDir);
        const inherited = runtimeStore.profiles["anthropic:inherited"];
        if (inherited?.type !== "api_key") {
          throw new Error("expected inherited API-key profile");
        }
        inherited.key = "sk-inherited-resolved";
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: customAgentDir, store: runtimeStore },
        ]);

        externalAuthTesting.setResolveExternalAuthProfilesForTest(() => {
          throw new Error("external auth hook must not run during postcommit rebuild");
        });
        try {
          await upsertAuthProfileWithLock({
            agentDir: customAgentDir,
            profileId: "openai:local",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "local-new",
              refresh: "local-refresh-new",
              expires: Date.now() + 120_000,
            },
          });
        } finally {
          externalAuthTesting.resetResolveExternalAuthProfilesForTest();
        }

        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["anthropic:inherited"],
        ).toMatchObject({
          key: "sk-inherited-resolved",
          keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(customAgentDir)?.profiles["openai:local"],
        ).toMatchObject({ access: "local-new", refresh: "local-refresh-new" });
      },
      { clearOAuthDir: true },
    );
  });

  it("clears runtime snapshots when postcommit publication throws", () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-runtime" },
          },
        },
      },
    ]);

    expect(
      storeTesting.publishRuntimeSnapshotsAfterCommit(() => {
        throw new Error("postcommit publication failed");
      }),
    ).toBe(false);
    expect(getRuntimeAuthProfileStoreSnapshot()).toBeUndefined();
  });

  it("keeps a direct save committed when postcommit publication throws", async () => {
    await withAuthProfileTestState("openclaw-auth-direct-publication-", async ({ agentDir }) => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
        },
      });
      saveAuthProfileStore(store("sk-old"), agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
        publish();
        throw new Error("postcommit publication failed");
      });
      let result: ReturnType<typeof saveAuthProfileStore> = undefined;
      try {
        expect(() => {
          result = saveAuthProfileStore(store("sk-new"), agentDir);
        }).not.toThrow();
      } finally {
        storeTesting.resetRuntimeSnapshotPublisherForTest();
      }

      expect(result).toBeUndefined();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toBeUndefined();
    });
  });

  it("publishes a caller-owned database transaction from the supplied store", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-transaction-", async ({ agentDir }) => {
      const store = (key: string): AuthProfileStore => ({
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key },
          "openai:backup": { type: "api_key", provider: "openai", key: "sk-backup" },
        },
        order: {
          openai:
            key === "sk-old"
              ? ["openai:default", "openai:backup"]
              : ["openai:backup", "openai:default"],
        },
      });
      saveAuthProfileStore(store("sk-old"), agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
      ]);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialMutationRevision(agentDir);
      const stateRevision = getRuntimeAuthProfileStoreStateMutationRevision(agentDir);

      runAuthProfileWriteTransaction(agentDir, (database) => {
        saveAuthProfileStore(store("sk-new"), agentDir, undefined, database);
      });

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
        key: "sk-new",
      });
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:default"],
      ).toMatchObject({ key: "sk-new" });
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.order?.openai).toEqual([
        "openai:backup",
        "openai:default",
      ]);
      expect(getRuntimeAuthProfileStoreCredentialMutationRevision(agentDir)).toBeGreaterThan(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationRevision(agentDir)).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  it("preserves derived runtime snapshots on a caller-owned main-store no-op", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-caller-noop-",
      async ({ agentDir, agentDirFor }) => {
        const derivedAgentDir = agentDirFor("worker");
        const mainStore: AuthProfileStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-main" },
          },
        };
        saveAuthProfileStore(mainStore, agentDir);
        const derivedStore = loadAuthProfileStoreForRuntime(derivedAgentDir);
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir, store: loadAuthProfileStoreForRuntime(agentDir) },
          { agentDir: derivedAgentDir, store: derivedStore },
        ]);

        runAuthProfileWriteTransaction(agentDir, (database) => {
          saveAuthProfileStore(mainStore, agentDir, undefined, database);
        });

        expect(getRuntimeAuthProfileStoreSnapshot(derivedAgentDir)).toEqual(derivedStore);
      },
    );
  });

  it("drops caller-owned publication when a nested savepoint rolls back", async () => {
    await withAuthProfileTestState("openclaw-auth-caller-savepoint-", async ({ agentDir }) => {
      const initial: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-initial" },
        },
      };
      const candidate: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-candidate" },
        },
      };
      saveAuthProfileStore(initial, agentDir);
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: initial }]);

      runAuthProfileWriteTransaction(agentDir, () => {
        expect(() =>
          runAuthProfileWriteTransaction(agentDir, (database) => {
            saveAuthProfileStore(candidate, agentDir, undefined, database);
            throw new Error("rollback savepoint");
          }),
        ).toThrow("rollback savepoint");
      });

      expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(initial);
      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toEqual(initial);
    });
  });

  it("rolls back credentials when the state write fails", async () => {
    await withAuthProfileTestState("openclaw-auth-atomic-save-", async ({ agentDir }) => {
      const oldStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:old": { type: "api_key", provider: "openai", key: "sk-old" },
        },
        order: { openai: ["openai:old"] },
      };
      saveAuthProfileStore(oldStore, agentDir);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialMutationRevision(agentDir);
      const stateRevision = getRuntimeAuthProfileStoreStateMutationRevision(agentDir);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      database.db.exec(`
        CREATE TRIGGER reject_auth_profile_state_update
        BEFORE UPDATE ON auth_profile_state
        BEGIN
          SELECT RAISE(ABORT, 'injected auth state write failure');
        END;
      `);

      expect(() =>
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:new": { type: "api_key", provider: "openai", key: "sk-new" },
            },
            order: { openai: ["openai:new"] },
          },
          agentDir,
        ),
      ).toThrow("injected auth state write failure");
      database.db.exec("DROP TRIGGER reject_auth_profile_state_update;");

      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir)).toMatchObject(oldStore);
      expect(getRuntimeAuthProfileStoreCredentialMutationRevision(agentDir)).toBe(
        credentialRevision,
      );
      expect(getRuntimeAuthProfileStoreStateMutationRevision(agentDir)).toBe(stateRevision);
    });
  });

  it("restores materialized and runtime-external snapshot credentials after a temporary write", async () => {
    await withAuthProfileTestState("openclaw-auth-runtime-restore-", async ({ agentDir }) => {
      const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-materialized",
              keyRef,
            },
          },
        },
        agentDir,
      );
      const runtimeStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-materialized",
            keyRef,
          },
          "anthropic:external": {
            type: "oauth",
            provider: "anthropic",
            access: "external-access",
            refresh: "external-refresh",
            expires: Date.now() + 60_000,
          },
        },
        runtimeExternalProfileIds: ["anthropic:external"],
      };
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: runtimeStore }]);
      const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot,
        agentDir,
        store: {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:temporary": {
              type: "api_key",
              provider: "openai",
              key: "sk-temporary",
            },
          },
        },
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      const { owned } = committed;
      restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

      expect(getRuntimeAuthProfileStoreSnapshot(agentDir)).toMatchObject(runtimeStore);
      expect(
        getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
      ).toBeUndefined();
    });
  });

  it.each(["before save", "before publication"] as const)(
    "preserves a runtime-only OAuth mutation %s",
    async (mutationTiming) => {
      await withAuthProfileTestState(
        "openclaw-auth-runtime-edge-ownership-",
        async ({ agentDir }) => {
          const baselineStore: AuthProfileStore = {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:baseline": {
                type: "api_key",
                provider: "openai",
                key: "sk-baseline",
              },
              "anthropic:external": {
                type: "oauth",
                provider: "anthropic",
                access: "external-before-capture",
                refresh: "external-refresh",
                expires: Date.now() + 60_000,
              },
            },
            runtimeExternalProfileIds: ["anthropic:external"],
          };
          saveAuthProfileStore(baselineStore, agentDir);
          replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: baselineStore }]);
          const snapshot = captureAuthProfileStorePersistenceSnapshot(agentDir);

          const mutateRuntimeStore = () => {
            replaceRuntimeAuthProfileStoreSnapshots([
              {
                agentDir,
                store: {
                  ...baselineStore,
                  profiles: {
                    ...baselineStore.profiles,
                    "anthropic:external": {
                      type: "oauth",
                      provider: "anthropic",
                      access: "external-after-capture",
                      refresh: "external-refresh-new",
                      expires: Date.now() + 120_000,
                    },
                  },
                },
              },
            ]);
          };
          if (mutationTiming === "before save") {
            mutateRuntimeStore();
          }
          const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
            snapshot,
            agentDir,
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:temporary": {
                  type: "api_key",
                  provider: "openai",
                  key: "sk-temporary",
                },
              },
            },
          });
          if (mutationTiming === "before publication") {
            storeTesting.setRuntimeSnapshotPublisherForTest((publish) => {
              storeTesting.resetRuntimeSnapshotPublisherForTest();
              mutateRuntimeStore();
              publish();
            });
          }
          expect(committed.publishRuntimeSnapshots()).toBe(true);
          const { owned } = committed;

          restoreAuthProfileStorePersistenceSnapshot(snapshot, owned, agentDir);

          expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles).toMatchObject({
            "openai:baseline": { key: "sk-baseline" },
            "anthropic:external": {
              access: "external-after-capture",
              refresh: "external-refresh-new",
            },
          });
          expect(
            getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:temporary"],
          ).toBeUndefined();
        },
        { clearOAuthDir: true },
      );
    },
  );

  it("restores captured and rebuilds newer derived snapshots after main rollback", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-main-derived-rollback-",
      async ({ agentDirFor }) => {
        const capturedAgentDir = agentDirFor("captured");
        const newerAgentDir = agentDirFor("newer");
        const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:baseline": {
              type: "api_key",
              provider: "openai",
              keyRef,
            },
          },
        });
        const capturedRuntime = loadAuthProfileStoreForRuntime(capturedAgentDir);
        const capturedProfile = capturedRuntime.profiles["openai:baseline"];
        if (capturedProfile?.type !== "api_key") {
          throw new Error("expected captured derived API-key profile");
        }
        capturedProfile.key = "sk-captured-resolved";
        capturedRuntime.profiles["anthropic:captured-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "captured-external-access",
          refresh: "captured-external-refresh",
          expires: Date.now() + 60_000,
        };
        capturedRuntime.runtimeExternalProfileIds = ["anthropic:captured-external"];
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: capturedRuntime },
        ]);
        const snapshot = captureAuthProfileStorePersistenceSnapshot();

        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          snapshot,
          store: {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:temporary": {
                type: "api_key",
                provider: "openai",
                key: "sk-temporary",
              },
            },
          },
        });
        capturedRuntime.profiles["anthropic:captured-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "captured-publication-edge-access",
          refresh: "captured-publication-edge-refresh",
          expires: Date.now() + 120_000,
        };
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: capturedRuntime },
        ]);
        expect(committed.publishRuntimeSnapshots()).toBe(true);
        const { owned } = committed;
        const ownedCapturedRuntime = getRuntimeAuthProfileStoreSnapshot(capturedAgentDir);
        if (!ownedCapturedRuntime) {
          throw new Error("expected apply-owned derived runtime snapshot");
        }
        expect(ownedCapturedRuntime.profiles["openai:baseline"]).toBeUndefined();
        expect(ownedCapturedRuntime.profiles["anthropic:captured-external"]).toMatchObject({
          access: "captured-publication-edge-access",
          refresh: "captured-publication-edge-refresh",
        });
        const newerRuntime = loadAuthProfileStoreForRuntime(newerAgentDir);
        newerRuntime.profiles["anthropic:newer-external"] = {
          type: "oauth",
          provider: "anthropic",
          access: "newer-external-access",
          refresh: "newer-external-refresh",
          expires: Date.now() + 60_000,
        };
        newerRuntime.runtimeExternalProfileIds = ["anthropic:newer-external"];
        replaceRuntimeAuthProfileStoreSnapshots([
          { agentDir: capturedAgentDir, store: ownedCapturedRuntime },
          { agentDir: newerAgentDir, store: newerRuntime },
        ]);

        restoreAuthProfileStorePersistenceSnapshot(snapshot, owned);

        expect(getRuntimeAuthProfileStoreSnapshot(capturedAgentDir)?.profiles).toMatchObject({
          "openai:baseline": { key: "sk-captured-resolved", keyRef },
          "anthropic:captured-external": {
            access: "captured-publication-edge-access",
            refresh: "captured-publication-edge-refresh",
          },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(capturedAgentDir)?.profiles["openai:temporary"],
        ).toBeUndefined();
        expect(getRuntimeAuthProfileStoreSnapshot(newerAgentDir)?.profiles).toMatchObject({
          "openai:baseline": { keyRef },
          "anthropic:newer-external": { access: "newer-external-access" },
        });
        expect(
          getRuntimeAuthProfileStoreSnapshot(newerAgentDir)?.profiles["openai:temporary"],
        ).toBeUndefined();
      },
      { clearOAuthDir: true },
    );
  });

  it("tracks state-only saves without advancing credential ownership", async () => {
    await withAuthProfileTestState("openclaw-auth-state-lineage-", async ({ agentDir }) => {
      const store: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-stable" },
        },
      };
      saveAuthProfileStore(store, agentDir);
      const credentialRevision = getRuntimeAuthProfileStoreCredentialsRevision();
      const stateRevision = getRuntimeAuthProfileStoreStateMutationRevision(agentDir);

      saveAuthProfileStore(
        { ...store, usageStats: { "openai:default": { lastUsed: 42 } } },
        agentDir,
      );

      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(credentialRevision);
      expect(getRuntimeAuthProfileStoreStateMutationRevision(agentDir)).toBeGreaterThan(
        stateRevision,
      );
    });
  });

  it("marks newly saved runtime snapshot profiles as persisted", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-runtime-persisted-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir,
            store: {
              version: AUTH_STORE_VERSION,
              profiles: {},
            },
          },
        ]);
        try {
          saveAuthProfileStore(
            {
              version: AUTH_STORE_VERSION,
              profiles: {
                "openai:work": {
                  type: "oauth",
                  provider: "openai",
                  access: "access-token",
                  refresh: "refresh-token",
                  expires: Date.now() + 60_000,
                  accountId: "account-123",
                },
              },
            },
            agentDir,
          );

          expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.runtimePersistedProfileIds).toEqual([
            "openai:work",
          ]);
          expect(
            getInternalRuntimeAuthProfileStoreSnapshot(agentDir)?.runtimeLocalProfileIds,
          ).toEqual(["openai:work"]);
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
      { clearOAuthDir: true },
    );
  });

  it("normalizes copied secrets when using the locked upsert path", async () => {
    await withAuthProfileTestState(
      "openclaw-auth-profile-upsert-",
      async ({ agentDir }) => {
        fs.mkdirSync(agentDir, { recursive: true });

        await upsertAuthProfileWithLock({
          profileId: "openai:manual",
          credential: {
            type: "token",
            provider: "openai",
            token: "  bearer\r\n-token\u2502  ",
          },
          agentDir,
        });
        await upsertAuthProfileWithLock({
          profileId: "anthropic:key",
          credential: {
            type: "api_key",
            provider: "anthropic",
            key: "  sk-\r\nant\u2502  ",
          },
          agentDir,
        });

        const store = loadAuthProfileStoreWithoutExternalProfiles(
          agentDir,
        ) as RuntimeAuthProfileStore;
        expect(store.runtimePersistedProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeLocalProfileIds).toEqual(["anthropic:key", "openai:manual"]);
        expect(store.runtimeExternalProfileIds).toBeUndefined();
        expect(store.runtimeExternalProfileIdsAuthoritative).toBeUndefined();
        const profiles = store.profiles;
        expect(profiles["openai:manual"]).toMatchObject({
          type: "token",
          provider: "openai",
          token: "bearer-token",
        });
        expect(profiles["anthropic:key"]).toMatchObject({
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        });
      },
      { clearOAuthDir: true },
    );
  });

  it("persists openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-metadata-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "local-access-token",
              refresh: "local-refresh-token",
              idToken: "local-id-token",
              expires,
              email: "dev@example.test",
              accountId: "acct-local",
              chatgptPlanType: "plus",
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];

      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "local-access-token",
        refresh: "local-refresh-token",
        idToken: "local-id-token",
        expires,
        email: "dev@example.test",
        accountId: "acct-local",
        chatgptPlanType: "plus",
      });
      expect(credential).not.toHaveProperty("oauthRef");
      expect(fs.existsSync(path.join(resolveOAuthDir(), "auth-profiles"))).toBe(false);

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "local-access-token",
          refresh: "local-refresh-token",
          idToken: "local-id-token",
        },
      );
    });
  });

  it("preserves access-only openai oauth credentials inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-access-only-", ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const profileId = "openai:default";
      const expires = Date.now() + 60 * 60 * 1000;
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              access: "access-only-token",
              expires,
            } as AuthProfileStore["profiles"][string],
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false },
      );

      const credential = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
      expectOAuthCredentialFields(credential, {
        provider: "openai",
        access: "access-only-token",
        expires,
      });
      expect(credential).not.toHaveProperty("oauthRef");

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        {
          provider: "openai",
          access: "access-only-token",
        },
      );
    });
  });

  it("keeps copied openai oauth profiles inline", async () => {
    await withAuthProfileTestState("openclaw-auth-profile-copy-ref-", ({ agentDirFor }) => {
      const mainAgentDir = agentDirFor("main");
      const copiedAgentDir = agentDirFor("copied");
      fs.mkdirSync(mainAgentDir, { recursive: true });
      fs.mkdirSync(copiedAgentDir, { recursive: true });
      const originalProfileId = "openai:default";
      const copiedProfileId = "openai:copied";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [originalProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "copy-access-token",
              refresh: "copy-refresh-token",
              expires: Date.now() + 60 * 60 * 1000,
              copyToAgents: true,
            },
          },
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      const originalCredential =
        loadAuthProfileStoreWithoutExternalProfiles(mainAgentDir).profiles[originalProfileId];
      expect(originalCredential?.type).toBe("oauth");
      if (!originalCredential || originalCredential.type !== "oauth") {
        throw new Error("expected original oauth credential");
      }
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [copiedProfileId]: originalCredential,
          },
        },
        copiedAgentDir,
        { filterExternalAuthProfiles: false },
      );

      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {},
        },
        mainAgentDir,
        { filterExternalAuthProfiles: false },
      );

      clearRuntimeAuthProfileStoreSnapshots();
      expectOAuthCredentialFields(
        loadAuthProfileStoreWithoutExternalProfiles(copiedAgentDir).profiles[copiedProfileId],
        {
          provider: "openai",
          access: "copy-access-token",
          refresh: "copy-refresh-token",
        },
      );
      expect(
        loadPersistedAuthProfileStore(copiedAgentDir)?.profiles[copiedProfileId],
      ).toMatchObject({
        access: "copy-access-token",
        refresh: "copy-refresh-token",
      });
    });
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-promote-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:bunsthedev@gmail.com";
      const staleProfileId = "openai:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            openai: [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
      });

      expect(updated?.order?.["openai"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    });
  });

  it("creates a per-agent provider order when relogin has no existing order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-create-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const primaryProfileId = "openai:primary-login";
      const backupProfileId = "openai:backup-login";
      const unrelatedProfileId = "openai:unrelated-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [primaryProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "primary-access",
              refresh: "primary-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [backupProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "backup-access",
              refresh: "backup-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [unrelatedProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "unrelated-access",
              refresh: "unrelated-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [backupProfileId, primaryProfileId],
      });

      expect(updated?.order?.["openai"]).toEqual([newProfileId, backupProfileId, primaryProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        backupProfileId,
        primaryProfileId,
      ]);
    });
  });

  it("preserves config-only fallback ids when creating a relogin order", async () => {
    await withAuthProfileTestState("openclaw-auth-order-config-only-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      const existingProfileId = "openai:old-login";
      const configOnlyProfileId = "openai:aws-sdk";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [existingProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "old-access",
              refresh: "old-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
        createIfMissing: true,
        createFromOrder: [existingProfileId, configOnlyProfileId],
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
      saveAuthProfileStore(loadAuthProfileStoreForRuntime(agentDir), agentDir);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toEqual([
        newProfileId,
        existingProfileId,
        configOnlyProfileId,
      ]);
    });
  });

  it("keeps implicit round-robin when relogin has no existing order by default", async () => {
    await withAuthProfileTestState("openclaw-auth-order-implicit-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai:new-login";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai"]).toBeUndefined();
    });
  });

  it("clears matching lastGood after a stale refresh_token_reused profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const staleProfileId = "openai:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            },
          },
          lastGood: { openai: staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: staleProfileId,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    });
  });

  it("removes selected profiles while preserving unrelated provider credentials", async () => {
    await withAuthProfileTestState("openclaw-auth-remove-selected-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openrouter:oauth": {
              type: "oauth",
              provider: "openrouter",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
            "openrouter:api-key": {
              type: "api_key",
              provider: "openrouter",
              key: "api-key",
            },
          },
          order: { openrouter: ["openrouter:oauth", "openrouter:api-key"] },
          lastGood: { openrouter: "openrouter:oauth" },
          usageStats: {
            "openrouter:oauth": { lastUsed: 1 },
            "openrouter:api-key": { lastUsed: 2 },
          },
        },
        agentDir,
      );

      await removeAuthProfilesWithLock({
        agentDir,
        profileIds: ["openrouter:oauth"],
      });

      expect(loadAuthProfileStoreForRuntime(agentDir)).toMatchObject({
        profiles: { "openrouter:api-key": expect.any(Object) },
        order: { openrouter: ["openrouter:api-key"] },
        usageStats: { "openrouter:api-key": { lastUsed: 2 } },
      });
      expect(loadAuthProfileStoreForRuntime(agentDir).profiles["openrouter:oauth"]).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    });
  });

  it("does not clear lastGood when the failed profile is not the stored profile", async () => {
    await withAuthProfileTestState("openclaw-auth-clear-lastgood-keep-", async ({ agentDir }) => {
      fs.mkdirSync(agentDir, { recursive: true });
      const goodProfileId = "openai:user@example.test";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: {
              type: "oauth",
              provider: "openai",
              access: "good-access-token",
              refresh: "good-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          lastGood: { openai: goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai",
        profileId: "openai:default",
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai"]).toBe(goodProfileId);
    });
  });
});
