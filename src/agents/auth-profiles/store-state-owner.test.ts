import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareSecretsRuntimeFastPathSnapshot } from "../../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  graftActiveSecretsRuntimeAuthState,
  restoreSecretsRuntimeSnapshotStateIfCurrent,
} from "../../secrets/runtime-state.js";
import { withEnv } from "../../test-utils/env.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  prepareRuntimeAuthProfileStoreSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
  restoreAuthProfileStorePersistenceSnapshot,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

describe("explicit auth state ownership", () => {
  it.each(["shared", "local", "mixed", "mixed-live", "cleared-local"] as const)(
    "preserves $0 bookkeeping ownership across shared-root activation",
    async (bookkeepingOwner) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const agentDir = first.agentDir;
      const localBookkeeping = bookkeepingOwner !== "shared";
      const profileId = localBookkeeping ? "local" : "shared";
      const updateBookkeeping = async (root: typeof first, lastUsed: number) => {
        await updateAuthProfileStoreWithLock({
          stateDir: root.stateDir,
          agentDir: localBookkeeping ? agentDir : undefined,
          saveOptions,
          updater: (current) => {
            current.usageStats = { [profileId]: { lastUsed, cooldownUntil: lastUsed + 60_000 } };
            return true;
          },
        });
      };
      const targetHasSharedState = !["shared", "local"].includes(bookkeepingOwner);
      if (targetHasSharedState) {
        await updateAuthProfileStoreWithLock({
          stateDir: first.stateDir,
          saveOptions,
          updater: (current) => {
            const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
            if (bookkeepingOwner === "cleared-local") {
              current.profiles.local = apiKey("shared-local");
            }
            current.usageStats = { [sharedProfileId]: { lastUsed: 30, cooldownUntil: 60_030 } };
            return true;
          },
        });
        const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
        expect(
          loadPersistedSharedAuthProfileStore(first.env)?.usageStats?.[sharedProfileId]?.lastUsed,
        ).toBe(30);
      }
      await updateBookkeeping(first, 10);
      if (bookkeepingOwner === "shared") {
        await updateBookkeeping(second, 20);
      } else if (bookkeepingOwner === "mixed-live") {
        await updateAuthProfileStoreWithLock({
          stateDir: second.stateDir,
          saveOptions,
          updater: (current) => {
            current.usageStats = { shared: { lastUsed: 40 } };
            return true;
          },
        });
      }
      withEnv(second.env, () =>
        setRuntimeAuthProfileStoreSnapshot(
          loadAuthProfileStoreWithoutExternalProfiles(agentDir),
          agentDir,
        ),
      );
      const prepared = prepareSecretsRuntimeFastPathSnapshot({
        config: {},
        env: first.env,
        agentDirs: [agentDir],
        loadAuthStore: () =>
          withEnv(first.env, () => loadAuthProfileStoreWithoutExternalProfiles(agentDir)),
      });
      if (!prepared) {
        throw new Error("missing prepared snapshot");
      }
      expect(prepared.snapshot.authStores[0]?.store?.runtimeInheritsMainState === true).toBe(
        bookkeepingOwner === "shared" ||
          bookkeepingOwner === "mixed" ||
          bookkeepingOwner === "mixed-live",
      );
      if (localBookkeeping) {
        if (bookkeepingOwner === "cleared-local") {
          await updateAuthProfileStoreWithLock({
            stateDir: second.stateDir,
            agentDir,
            saveOptions,
            updater: (current) => {
              delete current.usageStats;
              return true;
            },
          });
        } else {
          await updateBookkeeping(second, 20);
        }
        expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(
          prepared.snapshot.authStoreCredentialsRevision,
        );
        expect(snapshotAt(first.agentPath)?.runtimeInheritsMainState === true).toBe(
          bookkeepingOwner === "mixed-live",
        );
      }
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      const expectedLastUsed =
        bookkeepingOwner === "cleared-local" ? 30 : localBookkeeping ? 20 : 10;
      expect(snapshotAt(first.agentPath)?.usageStats?.[profileId]).toEqual({
        lastUsed: expectedLastUsed,
        cooldownUntil: expectedLastUsed + 60_000,
      });
      if (targetHasSharedState) {
        const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
        expect(snapshotAt(first.agentPath)?.usageStats?.[sharedProfileId]).toEqual({
          lastUsed: 30,
          cooldownUntil: 60_030,
        });
        expect(snapshotAt(first.agentPath)?.runtimeInheritsMainState).toBe(true);
      }
    },
  );

  it("keeps known public snapshot owners across an unrelated outer overlay update", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots(
      listOwnedRuntimeAuthProfileStoreSnapshots().map((entry) => {
        if (entry.databasePath === first.agentPath) {
          entry.store.usageStats = { shared: { lastUsed: 123 } };
        }
        return entry;
      }),
    );
    await updateAuthProfileStoreWithLock({
      stateDir: second.stateDir,
      saveOptions,
      updater: (current) => {
        current.profiles.shared = apiKey("updated-second");
        return true;
      },
    });
    expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("updated-second"));
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });

  it.each(["rollback", "newer", "newer-same", "graft"] as const)(
    "preserves shared-root authority through %s on one agent database",
    async (mode) => {
      const currentKey = mode === "newer-same" ? "second" : "third";
      const [first, second, third] = await Promise.all([
        seedRoot("first"),
        seedRoot("second"),
        seedRoot(currentKey),
      ]);
      const agentDir = tempDirs.make("openclaw-auth-owner-rebound-agent-");
      if (mode === "rollback") {
        await persistAuthProfileBatch({
          stateDir: first.stateDir,
          agentDir,
          profiles: [{ profileId: "local", credential: apiKey("stable-local") }],
        });
        for (const [root, lastUsed] of [
          [first, 10],
          [second, 20],
        ] as const) {
          await updateAuthProfileStoreWithLock({
            stateDir: root.stateDir,
            saveOptions,
            updater: (current) => {
              current.usageStats = { shared: { lastUsed } };
              return true;
            },
          });
        }
      }
      const prepare = (root: typeof first) => {
        const prepared = prepareSecretsRuntimeFastPathSnapshot({
          config: {},
          env: root.env,
          agentDirs: [agentDir],
          loadAuthStore: () =>
            withEnv(root.env, () => loadAuthProfileStoreWithoutExternalProfiles(agentDir)),
        });
        if (!prepared) {
          throw new Error("missing prepared snapshot");
        }
        return prepared;
      };
      const activate = (root: typeof first) => {
        const prepared = prepare(root);
        activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      };
      activate(first);
      const baseline = getActiveSecretsRuntimeSnapshotState()!;
      activate(second);
      const owned = getActiveSecretsRuntimeSnapshotState()!;
      const revision = getActiveSecretsRuntimeSnapshotRevisionState();
      const expected = mode === "rollback" ? first : third;
      if (mode === "rollback") {
        await updateAuthProfileStoreWithLock({
          stateDir: second.stateDir,
          agentDir,
          saveOptions,
          updater: (current) => {
            current.usageStats = { local: { lastUsed: 25 } };
            return true;
          },
        });
      }
      if (mode !== "rollback") {
        withEnv(third.env, () => setRuntimeAuthProfileStoreSnapshot(store(currentKey), agentDir));
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", third.stateDir);
      if (mode === "graft") {
        const prepared = prepare(first);
        graftActiveSecretsRuntimeAuthState(prepared.snapshot);
        activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      } else {
        expect(
          restoreSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: baseline,
            ownedSnapshot: owned,
            expectedRevision: revision,
            refreshContext: null,
            refreshHandler: null,
          }),
        ).toBe(true);
      }
      expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
        apiKey(mode === "rollback" ? "first" : currentKey),
      );
      if (mode === "rollback") {
        expect(
          snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.usageStats?.local?.lastUsed,
        ).toBe(25);
        expect(
          snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.usageStats?.shared?.lastUsed,
        ).toBe(10);
      }
      await updateAuthProfileStoreWithLock({
        stateDir: expected.stateDir,
        saveOptions,
        updater: (current) => {
          current.profiles.shared = apiKey("updated-owner");
          return true;
        },
      });
      expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
        apiKey("updated-owner"),
      );
    },
  );

  it("rejects a prepared snapshot after a scope-only owner transition", async () => {
    const first = await seedRoot("same");
    const second = await seedRoot("same");
    const agentDir = tempDirs.make("openclaw-auth-owner-stale-preparation-");
    withEnv(first.env, () => setRuntimeAuthProfileStoreSnapshot(store("same"), agentDir));
    const prepared = prepareSecretsRuntimeFastPathSnapshot({
      config: {},
      env: first.env,
      agentDirs: [agentDir],
      loadAuthStore: () => store("same"),
    });
    if (!prepared) {
      throw new Error("missing prepared snapshot");
    }
    withEnv(second.env, () => setRuntimeAuthProfileStoreSnapshot(store("same"), agentDir));
    expect(() =>
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null }),
    ).toThrow("stale");
  });

  it("hydrates a complete cold worker snapshot without reading unrelated outer SQLite", () => {
    const agentDir = tempDirs.make("openclaw-auth-owner-cold-worker-");
    const assertOuterUnchanged = unreadableOuter("future");
    expect(() =>
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: store("hydrated") }]),
    ).not.toThrow();
    expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
      apiKey("hydrated"),
    );
    expect(fs.readdirSync(agentDir)).toEqual([]);
    assertOuterUnchanged();
  });

  it("retains a removed snapshot owner through secrets activation rollback", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const captured = withEnv(first.env, () => {
      const activate = (authStores: Array<{ agentDir: string; store: AuthProfileStore }>) => {
        activateSecretsRuntimeSnapshotState({
          snapshot: {
            sourceConfig: {},
            config: {},
            authStores: prepareRuntimeAuthProfileStoreSnapshots(authStores),
            authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
            warnings: [],
            webTools: {
              search: { providerSource: "none", diagnostics: [] },
              fetch: { providerSource: "none", diagnostics: [] },
              diagnostics: [],
            },
          },
          refreshContext: null,
          refreshHandler: null,
        });
      };
      activate([
        {
          agentDir: first.agentDir,
          store: loadAuthProfileStoreWithoutExternalProfiles(first.agentDir),
        },
      ]);
      const baseline = getActiveSecretsRuntimeSnapshotState();
      activate([]);
      const owned = getActiveSecretsRuntimeSnapshotState();
      if (!baseline || !owned) {
        throw new Error("missing activated secrets snapshot");
      }
      return { baseline, owned, revision: getActiveSecretsRuntimeSnapshotRevisionState() };
    });
    expect(snapshotAt(first.agentPath)).toBeUndefined();
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    expect(
      restoreSecretsRuntimeSnapshotStateIfCurrent({
        snapshot: captured.baseline,
        ownedSnapshot: captured.owned,
        expectedRevision: captured.revision,
        refreshContext: null,
        refreshHandler: null,
      }),
    ).toBe(true);
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    await updateAuthProfileStoreWithLock({
      stateDir: first.stateDir,
      saveOptions,
      updater: (current) => {
        current.profiles.shared = apiKey("updated-first");
        return true;
      },
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(loadPersistedSharedAuthProfileStore(second.env)?.profiles.shared).toEqual(
      apiKey("second"),
    );
  });

  it("preserves ambient agent relocation for writes without an explicit state root", async () => {
    const stateDir = tempDirs.make("openclaw-auth-owner-ambient-");
    const agentDir = tempDirs.make("openclaw-auth-owner-relocated-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    writePersistedAuthProfileStoreRaw(store("initial"), agentDir);
    setRuntimeAuthProfileStoreSnapshot(loadAuthProfileStoreWithoutExternalProfiles());
    await updateAuthProfileStoreWithLock({
      saveOptions,
      updater: (current) => {
        current.profiles.shared = apiKey("updated");
        return true;
      },
    });
    expect(resolveSharedAuthStorePath()).toBe(resolveAuthProfileDatabasePath(agentDir));
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles.shared).toEqual(apiKey("updated"));
    expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
      apiKey("updated"),
    );
    expect(fs.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);
  });

  it("ignores agent relocation when the selected shared owner is the state database", async () => {
    const root = await seedRoot("first");
    const relocated = tempDirs.make("openclaw-auth-owner-irrelevant-relocation-");
    withEnv({ ...root.env, OPENCLAW_AGENT_DIR: relocated }, () => {
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
        root.agentDir,
      );
    });
    await updateAuthProfileStoreWithLock({
      stateDir: root.stateDir,
      saveOptions,
      updater: (current) => {
        current.profiles.shared = apiKey("updated");
        return true;
      },
    });
    expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("updated"));
    expect(fs.readdirSync(relocated)).toEqual([]);
  });

  it("keeps same-root legacy shared owners separate across agent relocation", () => {
    const stateDir = tempDirs.make("openclaw-auth-owner-legacy-root-");
    const roots = ["first", "second"].map((key) => {
      const sharedDir = tempDirs.make("openclaw-auth-owner-legacy-shared-");
      const agentDir = tempDirs.make("openclaw-auth-owner-legacy-derived-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: sharedDir };
      withEnv(env, () => {
        writePersistedAuthProfileStoreRaw(store(key), sharedDir);
        setRuntimeAuthProfileStoreSnapshot(loadAuthProfileStoreWithoutExternalProfiles());
        setRuntimeAuthProfileStoreSnapshot(
          loadAuthProfileStoreWithoutExternalProfiles(agentDir),
          agentDir,
        );
      });
      return { env, agentDir, sharedDir };
    });
    const first = roots[0]!;
    const second = roots[1]!;
    const before = captureAuthProfileStorePersistenceSnapshot(undefined, { env: first.env });
    const committed = withEnv(second.env, () =>
      saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: before,
        store: store("updated-first"),
        options: saveOptions,
      }),
    );
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    expect(snapshotAt(resolveAuthProfileDatabasePath(first.agentDir))?.profiles.shared).toEqual(
      apiKey("updated-first"),
    );
    expect(snapshotAt(resolveAuthProfileDatabasePath(second.agentDir))?.profiles.shared).toEqual(
      apiKey("second"),
    );
    expect(loadPersistedAuthProfileStore(second.sharedDir)?.profiles.shared).toEqual(
      apiKey("second"),
    );
  });

  it("rejects a save whose explicit state root disagrees with the captured owner", async () => {
    const root = await seedRoot("first");
    const otherStateDir = tempDirs.make("openclaw-auth-owner-mismatch-");
    const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, {
      stateDir: root.stateDir,
    });
    expect(() =>
      saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        stateDir: otherStateDir,
        store: store("must-not-write"),
        options: saveOptions,
      }),
    ).toThrow("owner");
    expect(loadPersistedSharedAuthProfileStore(root.env)?.profiles.shared).toEqual(apiKey("first"));
    expect(fs.readdirSync(otherStateDir)).toEqual([]);
  });

  it("rejects rollback whose explicit state root disagrees with the committed owner", async () => {
    const root = await seedRoot("first");
    const otherStateDir = tempDirs.make("openclaw-auth-owner-mismatch-");
    const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, {
      stateDir: root.stateDir,
    });
    const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
      snapshot: baseline,
      stateDir: root.stateDir,
      store: store("committed"),
      options: saveOptions,
    });
    expect(() =>
      restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned, undefined, {
        stateDir: otherStateDir,
      }),
    ).toThrow("owner");
    expect(loadPersistedSharedAuthProfileStore(root.env)?.profiles.shared).toEqual(
      apiKey("committed"),
    );
    expect(fs.readdirSync(otherStateDir)).toEqual([]);
  });

  it("refreshes only the selected root when the outer root is readable", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    withEnv(first.env, () => {
      setRuntimeAuthProfileStoreSnapshot(loadAuthProfileStoreWithoutExternalProfiles());
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(first.agentDir),
        first.agentDir,
      );
    });
    const otherSnapshots = listOwnedRuntimeAuthProfileStoreSnapshots().filter(
      (entry) =>
        entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    await updateAuthProfileStoreWithLock({
      stateDir: first.stateDir,
      saveOptions,
      updater: (current) => {
        current.profiles.shared = apiKey("updated-first");
        return true;
      },
    });
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(snapshotAt(first.agentPath)?.profiles).toMatchObject({
      shared: apiKey("updated-first"),
      local: apiKey("first-local"),
    });
    expect(
      listOwnedRuntimeAuthProfileStoreSnapshots().filter(
        (entry) =>
          entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
      ),
    ).toEqual(otherSnapshots);
  });

  it.each(["future", "invalid"] as const)(
    "publishes and compensates only the selected root under %s outer state",
    async (kind) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const otherSnapshots = listOwnedRuntimeAuthProfileStoreSnapshots().filter(
        (entry) =>
          entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
      );
      const assertOuterUnchanged = unreadableOuter(kind);
      const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, {
        stateDir: first.stateDir,
      });
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        stateDir: first.stateDir,
        store: store("temporary"),
        options: saveOptions,
      });
      expect(loadPersistedSharedAuthProfileStore(first.env)?.profiles.shared).toEqual(
        apiKey("temporary"),
      );
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("temporary"));
      const derived = snapshotAt(first.agentPath);
      expect(derived?.profiles).toMatchObject({
        shared: apiKey("temporary"),
        local: apiKey("first-local"),
      });
      if (!derived) {
        throw new Error("missing first-root derived snapshot");
      }
      derived.profiles.external = {
        type: "token",
        provider: "anthropic",
        token: "runtime-only-fixture",
      };
      derived.runtimeExternalProfileIds = ["external"];
      replaceOwnedRuntimeAuthProfileStoreSnapshots(
        listOwnedRuntimeAuthProfileStoreSnapshots().map((entry) => {
          if (entry.databasePath === first.agentPath) {
            entry.store = derived;
          }
          return entry;
        }),
      );

      restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned);

      expect(loadPersistedSharedAuthProfileStore(first.env)?.profiles.shared).toEqual(
        apiKey("first"),
      );
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
      expect(snapshotAt(first.agentPath)?.profiles).toEqual({
        shared: apiKey("first"),
        local: apiKey("first-local"),
        external: derived.profiles.external,
      });
      expect(
        listOwnedRuntimeAuthProfileStoreSnapshots().filter(
          (entry) =>
            entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
        ),
      ).toEqual(otherSnapshots);
      expect(loadPersistedSharedAuthProfileStore(second.env)?.profiles.shared).toEqual(
        apiKey("second"),
      );
      assertOuterUnchanged();
    },
  );

  it("keeps concurrent batch compensation bound to its captured shared owner", async () => {
    const roots = await Promise.all([seedRoot("first"), seedRoot("second")]);
    const assertOuterUnchanged = unreadableOuter("future");
    const receipts = await Promise.all(
      roots.map(({ stateDir }) =>
        persistAuthProfileBatch({
          stateDir,
          profiles: [{ profileId: "attempt", credential: apiKey(stateDir) }],
        }),
      ),
    );
    const [firstReceipt, secondReceipt] = receipts;
    if (!firstReceipt || !secondReceipt) {
      throw new Error("missing batch compensation receipts");
    }
    firstReceipt.rollback();
    expect(loadPersistedSharedAuthProfileStore(roots[0].env)?.profiles.attempt).toBeUndefined();
    expect(loadPersistedSharedAuthProfileStore(roots[1].env)?.profiles.attempt).toEqual(
      apiKey(roots[1].stateDir),
    );
    expect(snapshotAt(roots[1].agentPath)?.profiles.attempt).toEqual(apiKey(roots[1].stateDir));
    secondReceipt.rollback();
    secondReceipt.rollback();
    for (const root of roots) {
      expect(loadPersistedSharedAuthProfileStore(root.env)?.profiles.attempt).toBeUndefined();
      expect(snapshotAt(root.agentPath)?.profiles.attempt).toBeUndefined();
    }
    assertOuterUnchanged();
  });

  it("deduplicates OAuth against the selected shared owner, not an unrelated ambient owner", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const oauth: AuthProfileCredential = {
      type: "oauth",
      provider: "anthropic",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 600_000,
    };
    await persistAuthProfileBatch({
      stateDir: second.stateDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    await persistAuthProfileBatch({
      stateDir: first.stateDir,
      agentDir: first.agentDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    expect(loadPersistedAuthProfileStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    await persistAuthProfileBatch({
      stateDir: first.stateDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    const freshAgentDir = tempDirs.make("openclaw-auth-owner-fresh-agent-");
    await updateAuthProfileStoreWithLock({
      stateDir: first.stateDir,
      agentDir: freshAgentDir,
      saveOptions,
      updater: (current) => {
        current.profiles.oauth = oauth;
        return true;
      },
    });
    expect(loadPersistedAuthProfileStore(freshAgentDir)?.profiles.oauth).toBeUndefined();
    // Existing local ownership is intentionally preserved, not retroactively deduplicated.
    expect(loadPersistedAuthProfileStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    expect(loadPersistedSharedAuthProfileStore(first.env)?.profiles.oauth).toEqual(oauth);
  });
});
