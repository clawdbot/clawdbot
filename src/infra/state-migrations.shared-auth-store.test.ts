import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStore(profileId: string, key: string) {
  return {
    version: 1,
    profiles: {
      [profileId]: { type: "api_key", provider: "openai", key },
    },
  };
}

describe("shared auth store relocation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const [{ closeOpenClawAgentDatabasesForTest }, { closeOpenClawStateDatabaseForTest }] =
      await Promise.all([
        import("../state/openclaw-agent-db.js"),
        import("../state/openclaw-state-db.js"),
      ]);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  async function createFixture() {
    const stateDir = tempDirs.make("openclaw-shared-auth-relocate-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const [paths, ownership, sqlite, storeModule, persisted, authState, migration, stateDb] =
      await Promise.all([
        import("../agents/auth-profiles/shared-main-dir.js"),
        import("../agents/auth-profiles/path-resolve.js"),
        import("../agents/auth-profiles/sqlite.js"),
        import("../agents/auth-profiles/store.js"),
        import("../agents/auth-profiles/persisted.js"),
        import("../agents/auth-profiles/state.js"),
        import("./state-migrations.shared-auth-store.js"),
        import("../state/openclaw-state-db.js"),
      ]);
    const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
    const opsAgentDir = path.join(stateDir, "agents", "ops", "agent");
    const sharedStore = makeStore("openai:shared", "shared-key");
    const sharedState = {
      version: 1,
      order: { openai: ["openai:shared"] },
      lastGood: { openai: "openai:shared" },
    };
    const opsStore = makeStore("openai:ops", "ops-key");
    sqlite.writePersistedAuthProfileStoreRaw(sharedStore, mainAgentDir);
    sqlite.writePersistedAuthProfileStateRaw(sharedState, mainAgentDir);
    sqlite.writePersistedAuthProfileStoreRaw(opsStore, opsAgentDir);
    return {
      env,
      stateDir,
      mainAgentDir,
      opsAgentDir,
      sharedStore,
      sharedState,
      ownership,
      sqlite,
      storeModule,
      persisted,
      authState,
      migration,
      stateDb,
    };
  }

  async function createEmptyFixture(createSourceDatabase: boolean) {
    const stateDir = tempDirs.make("openclaw-shared-auth-empty-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const [paths, ownership, sqlite, migration] = await Promise.all([
      import("../agents/auth-profiles/shared-main-dir.js"),
      import("../agents/auth-profiles/path-resolve.js"),
      import("../agents/auth-profiles/sqlite.js"),
      import("./state-migrations.shared-auth-store.js"),
    ]);
    const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
    const sourcePath = sqlite.resolveAuthProfileDatabasePath(mainAgentDir);
    if (createSourceDatabase) {
      sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, mainAgentDir);
      sqlite.deletePersistedAuthProfileStoreRaw(mainAgentDir);
    }
    return { env, stateDir, sourcePath, ownership, migration };
  }

  it.each([
    { label: "fresh profile", createSourceDatabase: false },
    { label: "legacy profile with an empty source database", createSourceDatabase: true },
  ])("records ownership without reporting relocation for a $label", async (testCase) => {
    const fixture = await createEmptyFixture(testCase.createSourceDatabase);
    expect(fs.existsSync(fixture.sourcePath)).toBe(testCase.createSourceDatabase);

    const detected = fixture.migration.detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.hasLegacy).toBe(true);
    expect(
      await fixture.migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
      }),
    ).toEqual({ changes: [], warnings: [] });
    expect(fixture.ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
      location: "state-db",
    });
  });

  it("moves exact rows, preserves every effective agent store, and records receipts", async () => {
    const fixture = await createFixture();
    const effectiveBytes = (agentDir: string) => {
      const effective = fixture.storeModule.loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      return JSON.stringify({
        credentials: fixture.persisted.buildPersistedAuthProfileSecretsStore(effective),
        state: fixture.authState.buildPersistedAuthProfileState(effective),
      });
    };
    const before = {
      main: effectiveBytes(fixture.mainAgentDir),
      ops: effectiveBytes(fixture.opsAgentDir),
    };
    const detected = fixture.migration.detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      doctorOnlyStateMigrations: true,
    });

    expect(
      await fixture.migration.migrateSharedAuthStore({ detected, stateDir: fixture.stateDir }),
    ).toMatchObject({ warnings: [], changes: [expect.stringContaining("Relocated shared auth")] });

    expect(fixture.sqlite.readPersistedAuthProfileStoreRaw()).toEqual(fixture.sharedStore);
    expect(fixture.sqlite.readPersistedAuthProfileStateRaw()).toEqual(fixture.sharedState);
    expect(fixture.sqlite.readPersistedAuthProfileStoreRaw(fixture.mainAgentDir)).toBeNull();
    expect(fixture.sqlite.readPersistedAuthProfileStateRaw(fixture.mainAgentDir)).toBeNull();
    expect({
      main: effectiveBytes(fixture.mainAgentDir),
      ops: effectiveBytes(fixture.opsAgentDir),
    }).toEqual(before);

    const database = fixture.stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    expect(
      database
        .prepare("SELECT store_key, store_json FROM auth_profile_stores WHERE store_key = 'shared'")
        .get(),
    ).toEqual({ store_key: "shared", store_json: JSON.stringify(fixture.sharedStore) });
    expect(
      database
        .prepare("SELECT store_key, state_json FROM auth_profile_state WHERE store_key = 'shared'")
        .get(),
    ).toEqual({ store_key: "shared", state_json: JSON.stringify(fixture.sharedState) });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM migration_sources WHERE migration_kind = ?")
        .get("shared-auth-store-state-db"),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'")
        .get(),
    ).toEqual({ value_json: JSON.stringify({ location: "state-db" }) });
  });

  for (const crashState of [
    "copied-not-flipped",
    "copied-source-empty-not-flipped",
    "flipped-not-cleaned",
    "flipped-cleaned-not-finalized",
  ] as const) {
    it(`converges after the ${crashState} stage boundary`, async () => {
      const fixture = await createFixture();
      const sourcePath = fixture.sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
      const source = new DatabaseSync(sourcePath);
      const sourceStore = source
        .prepare(
          "SELECT store_json, updated_at FROM auth_profile_store WHERE store_key = 'primary'",
        )
        .get() as { store_json: string; updated_at: number };
      const sourceState = source
        .prepare(
          "SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = 'primary'",
        )
        .get() as { state_json: string; updated_at: number };
      const target = fixture.stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
      target
        .prepare("INSERT INTO auth_profile_stores VALUES ('shared', ?, ?)")
        .run(sourceStore.store_json, sourceStore.updated_at);
      target
        .prepare("INSERT INTO auth_profile_state VALUES ('shared', ?, ?)")
        .run(sourceState.state_json, sourceState.updated_at);
      if (
        crashState === "copied-source-empty-not-flipped" ||
        crashState === "flipped-cleaned-not-finalized"
      ) {
        source.prepare("DELETE FROM auth_profile_store WHERE store_key = 'primary'").run();
        source.prepare("DELETE FROM auth_profile_state WHERE state_key = 'primary'").run();
      }
      source.close();
      if (crashState === "flipped-not-cleaned" || crashState === "flipped-cleaned-not-finalized") {
        target
          .prepare(
            `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
             VALUES ('auth.sharedStore', ?, 1)`,
          )
          .run(JSON.stringify({ location: "state-db" }));
        fixture.ownership.noteCommittedSharedAuthStoreOwnership(
          { location: "state-db" },
          fixture.env,
        );
        const runId = "test-shared-auth-pending-cleanup";
        const sourceKey = `shared-auth-store:${createHash("sha256")
          .update(path.resolve(sourcePath))
          .update("\0")
          .update("auth_profile_store")
          .digest("hex")}`;
        target
          .prepare(
            `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json)
             VALUES (?, 1, NULL, 'ownership-flipped', '{}')`,
          )
          .run(runId);
        target
          .prepare(
            `INSERT INTO migration_sources
               (source_key, migration_kind, source_path, target_table, source_sha256,
                source_size_bytes, source_record_count, last_run_id, status, imported_at,
                removed_source, report_json)
             VALUES (?, 'shared-auth-store-state-db', ?, 'auth_profile_stores', NULL,
                     NULL, NULL, ?, 'ownership-flipped', 1, 0, '{}')`,
          )
          .run(sourceKey, sourcePath, runId);
      }

      const detected = fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      });
      const first = await fixture.migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
      });
      const retryDetected = fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      });
      const retry = await fixture.migration.migrateSharedAuthStore({
        detected: retryDetected,
        stateDir: fixture.stateDir,
      });

      expect(first.warnings).toEqual([]);
      expect(retryDetected).toMatchObject({ hasLegacy: false });
      expect(fixture.ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
        location: "state-db",
      });
      expect(retry).toEqual({ changes: [], warnings: [] });
      expect(target.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get()).toEqual({
        count: 1,
      });
      expect(target.prepare("SELECT COUNT(*) AS count FROM auth_profile_state").get()).toEqual({
        count: 1,
      });
      const cleanedSource = new DatabaseSync(sourcePath, { readOnly: true });
      expect(
        cleanedSource
          .prepare("SELECT COUNT(*) AS count FROM auth_profile_store WHERE store_key = 'primary'")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        cleanedSource
          .prepare("SELECT COUNT(*) AS count FROM auth_profile_state WHERE state_key = 'primary'")
          .get(),
      ).toEqual({ count: 0 });
      cleanedSource.close();
    });
  }

  it("fails closed when the legacy source is a dangling symlink", async () => {
    const fixture = await createFixture();
    const sourcePath = fixture.sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
    closeOpenClawAgentDatabasesForTest();
    fs.unlinkSync(sourcePath);
    fs.symlinkSync(`${sourcePath}.missing`, sourcePath);

    expect(() =>
      fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "SharedAuthStoreSourceInspectionError",
        code: "SHARED_AUTH_STORE_SOURCE_UNREADABLE",
        action: "openclaw doctor --fix",
        sourcePath,
      }),
    );
    expect(
      fixture.stateDb
        .openOpenClawStateDatabase({ env: fixture.env })
        .db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("inspects an unreadable legacy source only in the explicit Doctor path", async () => {
    const fixture = await createFixture();
    const sourcePath = fixture.sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const realLstat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
      if (path.resolve(String(pathname)) === path.resolve(sourcePath)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return realLstat(pathname, options as never);
    });

    expect(
      fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: false,
      }),
    ).toEqual({ sourcePath, hasLegacy: false });
    expect(() =>
      fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "SharedAuthStoreSourceInspectionError",
        code: "SHARED_AUTH_STORE_SOURCE_UNREADABLE",
        sourcePath,
      }),
    );
    expect(
      fixture.stateDb
        .openOpenClawStateDatabase({ env: fixture.env })
        .db.prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'",
        )
        .get(),
    ).toBeUndefined();
  });
});
