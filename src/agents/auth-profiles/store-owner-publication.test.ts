import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSecretsRuntimeFastPathSnapshot } from "../../secrets/runtime-fast-path.js";
import { activateSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withEnv } from "../../test-utils/env.js";
import {
  assertAuthProfileMigrationReady,
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./mutation-lineage.js";
import { loadPersistedSharedAuthProfileStore } from "./persisted.js";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  restoreAuthProfileStorePersistenceSnapshot,
  saveAuthProfileStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
  updateAuthProfileStoreWithLock,
  withAuthProfileStoreAgentDir,
} from "./store.js";
import type { AuthProfileCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

describe("auth publication owner receipts", () => {
  it.each(["prepare", "activate"] as const)(
    "requires a recorded migration diagnosis discovered at %s before empty-owner activation",
    async (discoveredAt) => {
      const { prepareSecretsRuntimeSnapshot } = await import("../../secrets/runtime.js");
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const agentDir = tempDirs.make("openclaw-auth-owner-empty-activation-");
      await updateAuthProfileStoreWithLock({
        stateDir: first.stateDir,
        saveOptions,
        updater: (current) => {
          current.profiles = {};
          return true;
        },
      });
      withEnv(second.env, () =>
        setRuntimeAuthProfileStoreSnapshot(
          loadAuthProfileStoreWithoutExternalProfiles(agentDir),
          agentDir,
        ),
      );
      const legacyPath = path.join(agentDir, "auth.json");
      if (discoveredAt === "prepare") {
        fs.writeFileSync(legacyPath, "{}");
      }
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: first.env,
        agentDirs: [agentDir],
        allowUnavailableSecretOwners: true,
        loadAuthStore: () =>
          withEnv(first.env, () => loadAuthProfileStoreWithoutExternalProfiles(agentDir)),
      });
      expect(snapshot.authStores[0]?.store.profiles).toEqual({});
      const activate = () =>
        activateSecretsRuntimeSnapshotState({
          snapshot,
          refreshContext: null,
          refreshHandler: null,
        });
      if (discoveredAt === "prepare") {
        expect(snapshot.degradedOwners).toHaveLength(1);
        expect(activate).not.toThrow();
        expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles).toEqual({});
      } else {
        expect(snapshot.degradedOwners).toEqual([]);
        fs.writeFileSync(legacyPath, "{}");
        expect(activate).toThrow("requires legacy credential migration");
        expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
          apiKey("second"),
        );
      }
    },
  );

  it.each(["update", "capture"] as const)(
    "honors an explicit state root over the enclosing scope during %s",
    async (operation) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      await withAuthProfileStoreAgentDir(first.agentDir, second.stateDir, async () => {
        if (operation === "update") {
          await updateAuthProfileStoreWithLock({
            agentDir: first.agentDir,
            stateDir: first.stateDir,
            saveOptions,
            updater: (current) => {
              current.profiles = { local: apiKey("updated-local") };
              return true;
            },
          });
        } else {
          const snapshot = captureAuthProfileStorePersistenceSnapshot(first.agentDir, {
            stateDir: first.stateDir,
          });
          const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
            snapshot,
            agentDir: first.agentDir,
            store: { version: 1, profiles: { local: apiKey("updated-local") } },
            options: saveOptions,
          });
          expect(committed.publishRuntimeSnapshots()).toBe(true);
        }
      });
      expect(snapshotAt(first.agentPath)?.profiles).toEqual({
        local: apiKey("updated-local"),
        shared: apiKey("first"),
      });
      expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
    },
  );

  it("retains inherited persisted provenance after an ordinary local rebuild", async () => {
    const root = await seedRoot("original");
    withEnv(root.env, () =>
      saveAuthProfileStore(
        { version: 1, profiles: { local: apiKey("updated-local") } },
        root.agentDir,
        saveOptions,
      ),
    );
    expect(snapshotAt(root.agentPath)?.runtimePersistedProfileIds).toEqual(["local", "shared"]);
  });

  it.each([
    { unreadableLocal: false, populated: false },
    { unreadableLocal: true, populated: false },
    { unreadableLocal: false, populated: true },
    { unreadableLocal: true, populated: true },
  ])(
    "validates committed shared migration facts with unreadableLocal=$unreadableLocal populated=$populated",
    async ({ unreadableLocal, populated }) => {
      const root = await seedRoot("original");
      const oauthDir = tempDirs.make("openclaw-auth-owner-late-oauth-");
      const env = { ...root.env, OPENCLAW_OAUTH_DIR: oauthDir };
      withEnv(env, () =>
        setRuntimeAuthProfileStoreSnapshot(
          loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
          root.agentDir,
        ),
      );
      if (unreadableLocal) {
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid" }, root.agentDir);
      }
      const legacyPath = path.join(oauthDir, "oauth.json");
      fs.writeFileSync(legacyPath, "{}");
      withEnv(env, () =>
        saveAuthProfileStore(
          { version: 1, profiles: populated ? { shared: apiKey("updated") } : {} },
          undefined,
          saveOptions,
        ),
      );
      fs.unlinkSync(legacyPath);
      // The removed file cannot make this assertion discover the refusal itself.
      if (populated) {
        expect(() => assertAuthProfileMigrationReady(undefined, env)).not.toThrow();
        expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("updated"));
      } else {
        expect(() => assertAuthProfileMigrationReady(undefined, env)).toThrow(
          "requires legacy credential migration",
        );
        expect(snapshotAt(root.agentPath)).toBeUndefined();
      }
    },
  );

  it.each(["credentials", "state"] as const)(
    "records committed %s changes and evicts derived snapshots when migration refuses publication",
    async (kind) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const readToken =
        kind === "credentials"
          ? getRuntimeAuthProfileStoreCredentialMutationToken
          : getRuntimeAuthProfileStoreStateMutationToken;
      const before = withEnv(first.env, () => readToken().revision);
      markAuthProfileMigrationRequired(
        undefined,
        new AuthProfileMigrationRequiredError({
          env: first.env,
          sources: [],
        }),
        first.env,
      );
      const next =
        kind === "credentials"
          ? store("updated-first")
          : {
              ...store("first"),
              order: { openai: ["shared"] },
            };
      withEnv(second.env, () =>
        saveAuthProfileStore(
          next,
          undefined,
          saveOptions,
          openOpenClawStateDatabase({ env: first.env }),
        ),
      );
      expect(loadPersistedSharedAuthProfileStore(first.env)).toMatchObject(next);
      expect(snapshotAt(first.agentPath)).toBeUndefined();
      expect(withEnv(first.env, () => readToken().revision)).toBeGreaterThan(before);
      expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
      expect(() => assertAuthProfileMigrationReady(undefined, first.env)).toThrow(
        "requires legacy credential migration",
      );
    },
  );

  it("does not restore a credential snapshot over a newer migration refusal", async () => {
    const root = await seedRoot("original");
    const baseline = captureAuthProfileStorePersistenceSnapshot(root.agentDir, { env: root.env });
    const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
      snapshot: baseline,
      agentDir: root.agentDir,
      store: { version: 1, profiles: { local: apiKey("temporary") } },
      options: saveOptions,
    });
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    markAuthProfileMigrationRequired(
      root.agentDir,
      new AuthProfileMigrationRequiredError({
        agentDir: root.agentDir,
        env: root.env,
        sources: [],
      }),
      root.env,
    );
    restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned, root.agentDir);
    expect(snapshotAt(root.agentPath)).toBeUndefined();
    expect(() => assertAuthProfileMigrationReady(root.agentDir, root.env)).toThrow(
      "requires legacy credential migration",
    );
  });

  it.each([
    { refusedOwner: "child", newer: false, stateOnly: false },
    { refusedOwner: "child", newer: true, stateOnly: false },
    { refusedOwner: "shared", newer: false, stateOnly: false },
    { refusedOwner: "shared", newer: false, stateOnly: true },
  ])(
    "isolates $refusedOwner rollback refusal with newer=$newer stateOnly=$stateOnly",
    async ({ refusedOwner, newer, stateOnly }) => {
      const root = await seedRoot("original");
      const healthyAgentDir = tempDirs.make("openclaw-auth-owner-healthy-sibling-");
      const healthyPath = resolveAuthProfileDatabasePath(healthyAgentDir);
      withEnv(root.env, () =>
        setRuntimeAuthProfileStoreSnapshot(
          loadAuthProfileStoreWithoutExternalProfiles(healthyAgentDir),
          healthyAgentDir,
        ),
      );
      const unrelated = await seedRoot("unrelated");
      const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, { env: root.env });
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        store: stateOnly
          ? { ...store("original"), usageStats: { shared: { lastUsed: 99 } } }
          : store("temporary"),
        options: saveOptions,
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      if (newer) {
        const current = snapshotAt(root.agentPath);
        if (!current) {
          throw new Error("missing child runtime snapshot");
        }
        current.usageStats = { shared: { lastUsed: 123 } };
        withEnv(root.env, () => setRuntimeAuthProfileStoreSnapshot(current, root.agentDir));
      }
      const refusedDir = refusedOwner === "child" ? root.agentDir : undefined;
      markAuthProfileMigrationRequired(
        refusedDir,
        new AuthProfileMigrationRequiredError({ agentDir: refusedDir, env: root.env, sources: [] }),
        root.env,
      );
      restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned);
      expect(loadPersistedSharedAuthProfileStore(root.env)?.profiles.shared).toEqual(
        apiKey("original"),
      );
      expect(snapshotAt(root.agentPath)).toBeUndefined();
      if (refusedOwner === "child") {
        expect(snapshotAt(root.sharedPath)?.profiles.shared).toEqual(apiKey("original"));
        expect(snapshotAt(healthyPath)?.profiles.shared).toEqual(apiKey("original"));
      } else {
        expect(snapshotAt(root.sharedPath)).toBeUndefined();
        expect(snapshotAt(healthyPath)).toBeUndefined();
      }
      expect(snapshotAt(unrelated.sharedPath)?.profiles.shared).toEqual(apiKey("unrelated"));
      expect(snapshotAt(unrelated.agentPath)?.profiles.shared).toEqual(apiKey("unrelated"));
      expect(() => assertAuthProfileMigrationReady(refusedDir, root.env)).toThrow(
        "requires legacy credential migration",
      );
    },
  );

  it.each([
    { file: "auth.json", populated: false, refused: true },
    { file: "auth.json", populated: true, refused: false },
    { file: "auth-state.json", populated: false, refused: false },
  ])(
    "preserves late $file migration semantics with populated=$populated",
    async ({ file, populated, refused }) => {
      const root = await seedRoot("original");
      fs.writeFileSync(path.join(root.agentDir, file), "{}");
      withEnv(root.env, () =>
        saveAuthProfileStore(
          {
            version: 1,
            profiles: populated ? { local: apiKey("updated-local") } : {},
          },
          root.agentDir,
          saveOptions,
        ),
      );
      if (refused) {
        expect(snapshotAt(root.agentPath)).toBeUndefined();
        expect(() => assertAuthProfileMigrationReady(root.agentDir, root.env)).toThrow(
          "requires legacy credential migration",
        );
      } else {
        expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("original"));
        expect(() => assertAuthProfileMigrationReady(root.agentDir, root.env)).not.toThrow();
      }
    },
  );

  it("retains a prepared owner's relocated legacy OAuth discovery during local rebuild", async () => {
    const root = await seedRoot("original");
    const oauthDir = tempDirs.make("openclaw-auth-owner-legacy-oauth-");
    const env = { ...root.env, OPENCLAW_OAUTH_DIR: oauthDir };
    withEnv(env, () => {
      saveAuthProfileStore({ version: 1, profiles: {} }, undefined, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
        root.agentDir,
      );
      fs.writeFileSync(path.join(oauthDir, "oauth.json"), "{}");
      saveAuthProfileStore(
        { version: 1, profiles: { local: apiKey("updated-local") } },
        root.agentDir,
        saveOptions,
      );
    });
    expect(snapshotAt(root.agentPath)).toBeUndefined();
    expect(() => assertAuthProfileMigrationReady(undefined, env)).toThrow(
      "requires legacy credential migration",
    );
  });

  it.each(
    (["transaction", "connection"] as const).flatMap((source) =>
      (["readable", "future", "invalid"] as const).map((outer) => ({ source, outer })),
    ),
  )(
    "preserves the selected shared owner for a supplied $source under a $outer ambient root",
    async ({ source, outer }) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const save = () => {
        if (source === "transaction") {
          runAuthProfileWriteTransaction(
            undefined,
            (database) =>
              saveAuthProfileStore(store("updated-first"), undefined, saveOptions, database),
            { stateDir: first.stateDir },
          );
        } else {
          saveAuthProfileStore(
            store("updated-first"),
            undefined,
            saveOptions,
            openOpenClawStateDatabase({ env: first.env }),
          );
        }
      };
      if (outer === "readable") {
        withEnv(second.env, save);
      } else {
        const assertOuterUnchanged = unreadableOuter(outer);
        save();
        assertOuterUnchanged();
      }
      expect(loadPersistedSharedAuthProfileStore(first.env)?.profiles.shared).toEqual(
        apiKey("updated-first"),
      );
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("updated-first"));
      expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-first"));
      expect(loadPersistedSharedAuthProfileStore(second.env)?.profiles.shared).toEqual(
        apiKey("second"),
      );
      expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
    },
  );

  it.each(["ordinary", "supplied"] as const)(
    "does not relabel another owner's resolved credentials during %s publication",
    async (publication) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const sharedRef = {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      } satisfies AuthProfileCredential;
      for (const root of [first, second]) {
        await persistAuthProfileBatch({
          stateDir: root.stateDir,
          profiles: [{ profileId: "shared", credential: sharedRef }],
        });
      }
      withEnv(first.env, () => {
        const current = loadAuthProfileStoreWithoutExternalProfiles(first.agentDir);
        current.profiles.shared = { ...sharedRef, key: "fixture-first-resolved" };
        current.profiles.external = {
          type: "oauth",
          provider: "anthropic",
          access: "fixture-first-access",
          refresh: "fixture-first-refresh",
          expires: Date.now() + 60_000,
        };
        current.runtimeExternalProfileIds = ["external"];
        setRuntimeAuthProfileStoreSnapshot(current, first.agentDir);
      });
      withEnv(second.env, () => {
        const next = loadAuthProfileStoreWithoutExternalProfiles(first.agentDir);
        if (publication === "ordinary") {
          saveAuthProfileStore(next, first.agentDir, saveOptions);
        } else {
          runAuthProfileWriteTransaction(first.agentDir, (database) => {
            saveAuthProfileStore(next, first.agentDir, saveOptions, database);
          });
        }
      });
      expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(sharedRef);
      expect(snapshotAt(first.agentPath)?.profiles.external).toBeUndefined();
    },
  );

  it("keeps the original shared owner after a bounded temporary-state exec save", async () => {
    const original = await seedRoot("original");
    const temporary = tempDirs.make("openclaw-auth-owner-bounded-temp-");
    withEnv({ ...original.env, OPENCLAW_STATE_DIR: temporary }, () => {
      withAuthProfileStoreAgentDir(original.agentDir, original.stateDir, () => {
        const current = ensureAuthProfileStoreWithoutExternalProfiles();
        saveAuthProfileStore(current, undefined, saveOptions);
      });
    });
    await persistAuthProfileBatch({
      stateDir: original.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-original") }],
    });
    expect(snapshotAt(original.agentPath)?.profiles.shared).toEqual(apiKey("updated-original"));
  });

  it("retains shared OAuth in the owner snapshot but excludes it from bounded exec", async () => {
    const original = await seedRoot("original");
    const oauth = {
      type: "oauth",
      provider: "openai",
      access: "fixture-shared-access",
      refresh: "fixture-shared-refresh",
      expires: Date.now() + 3_600_000,
    } satisfies AuthProfileCredential;
    await persistAuthProfileBatch({
      stateDir: original.stateDir,
      profiles: [{ profileId: "shared-oauth", credential: oauth }],
    });
    expect(snapshotAt(original.agentPath)?.profiles["shared-oauth"]).toEqual(oauth);
    const temporary = tempDirs.make("openclaw-auth-owner-bounded-oauth-");
    withEnv({ ...original.env, OPENCLAW_STATE_DIR: temporary }, () => {
      withAuthProfileStoreAgentDir(original.agentDir, original.stateDir, () => {
        const current = ensureAuthProfileStoreWithoutExternalProfiles();
        expect(current.profiles["shared-oauth"]).toBeUndefined();
        saveAuthProfileStore(current, undefined, saveOptions);
        expect(
          ensureAuthProfileStoreWithoutExternalProfiles().profiles["shared-oauth"],
        ).toBeUndefined();
      });
    });
    expect(snapshotAt(original.agentPath)?.profiles["shared-oauth"]).toEqual(oauth);
  });

  it("preserves an independently newer runtime owner with identical credential bytes", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const third = await seedRoot("second");
    withEnv(second.env, () =>
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(first.agentDir),
        first.agentDir,
      ),
    );
    const originalRuntime = snapshotAt(first.agentPath);
    if (!originalRuntime) {
      throw new Error("missing second-owner runtime");
    }
    const baseline = captureAuthProfileStorePersistenceSnapshot(first.agentDir, {
      stateDir: first.stateDir,
    });
    const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
      snapshot: baseline,
      agentDir: first.agentDir,
      stateDir: first.stateDir,
      store: { version: 1, profiles: { local: apiKey("temporary-local") } },
      options: saveOptions,
    });
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    withEnv(third.env, () => setRuntimeAuthProfileStoreSnapshot(originalRuntime, first.agentDir));
    restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned, first.agentDir, {
      stateDir: first.stateDir,
    });
    expect(snapshotAt(first.agentPath)?.profiles).toEqual(originalRuntime.profiles);
    await persistAuthProfileBatch({
      stateDir: third.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-third") }],
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-third"));
  });

  it("restores the captured runtime owner separately from the persistence transaction owner", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    withEnv(second.env, () =>
      setRuntimeAuthProfileStoreSnapshot(
        loadAuthProfileStoreWithoutExternalProfiles(first.agentDir),
        first.agentDir,
      ),
    );
    const baseline = captureAuthProfileStorePersistenceSnapshot(first.agentDir, {
      stateDir: first.stateDir,
    });
    const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
      snapshot: baseline,
      agentDir: first.agentDir,
      stateDir: first.stateDir,
      store: { version: 1, profiles: { local: apiKey("temporary-local") } },
      options: saveOptions,
    });
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned, first.agentDir, {
      stateDir: first.stateDir,
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("second"));
    await persistAuthProfileBatch({
      stateDir: second.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-second") }],
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-second"));
  });

  it.each(["publish", "compensate"] as const)(
    "reconciles two legacy roots sharing one relocated database during %s",
    (operation) => {
      const sharedDir = tempDirs.make("openclaw-auth-owner-aliased-legacy-");
      const roots = ["first", "second"].map(() => ({
        agentDir: tempDirs.make("openclaw-auth-owner-aliased-agent-"),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: tempDirs.make("openclaw-auth-owner-aliased-root-"),
          OPENCLAW_AGENT_DIR: sharedDir,
        },
      }));
      writePersistedAuthProfileStoreRaw(store("original"), sharedDir);
      for (const root of roots) {
        withEnv(root.env, () =>
          setRuntimeAuthProfileStoreSnapshot(
            loadAuthProfileStoreWithoutExternalProfiles(root.agentDir),
            root.agentDir,
          ),
        );
      }
      const first = roots[0]!;
      const second = roots[1]!;
      const baseline = captureAuthProfileStorePersistenceSnapshot(undefined, { env: first.env });
      const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        store: store("candidate"),
        options: saveOptions,
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      if (operation === "compensate") {
        withEnv(second.env, () =>
          setRuntimeAuthProfileStoreSnapshot(
            loadAuthProfileStoreWithoutExternalProfiles(second.agentDir),
            second.agentDir,
          ),
        );
        restoreAuthProfileStorePersistenceSnapshot(baseline, committed.owned);
      }
      expect(snapshotAt(resolveAuthProfileDatabasePath(second.agentDir))?.profiles.shared).toEqual(
        apiKey(operation === "publish" ? "candidate" : "original"),
      );
    },
  );

  it("activates a valid prepared owner without reopening an unrelated public cold scope", async () => {
    const first = await seedRoot("first");
    const coldAgentDir = tempDirs.make("openclaw-auth-owner-unrelated-cold-");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: coldAgentDir, store: store("cold") }]);
    const prepared = prepareSecretsRuntimeFastPathSnapshot({
      config: {},
      env: first.env,
      agentDirs: [first.agentDir],
      loadAuthStore: () =>
        withEnv(first.env, () => loadAuthProfileStoreWithoutExternalProfiles(first.agentDir)),
    });
    if (!prepared) {
      throw new Error("missing prepared snapshot");
    }
    expect(() =>
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null }),
    ).not.toThrow();
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });
});
