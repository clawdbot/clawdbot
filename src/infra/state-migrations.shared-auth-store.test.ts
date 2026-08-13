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
    const [paths, sqlite, storeModule, persisted, authState, migration, stateDb] =
      await Promise.all([
        import("../agents/auth-profiles/shared-main-dir.js"),
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
      sqlite,
      storeModule,
      persisted,
      authState,
      migration,
      stateDb,
    };
  }

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

  it("converges when target copies exist but the ownership flip is missing", async () => {
    const fixture = await createFixture();
    const sourcePath = fixture.sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const source = new DatabaseSync(sourcePath);
    const sourceStore = source
      .prepare("SELECT store_json, updated_at FROM auth_profile_store WHERE store_key = 'primary'")
      .get() as { store_json: string; updated_at: number };
    const sourceState = source
      .prepare("SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = 'primary'")
      .get() as { state_json: string; updated_at: number };
    source.close();
    const target = fixture.stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    target
      .prepare("INSERT INTO auth_profile_stores VALUES ('shared', ?, ?)")
      .run(sourceStore.store_json, sourceStore.updated_at);
    target
      .prepare("INSERT INTO auth_profile_state VALUES ('shared', ?, ?)")
      .run(sourceState.state_json, sourceState.updated_at);

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
    expect(retryDetected).toMatchObject({ ownership: { location: "state-db" }, hasLegacy: false });
    expect(retry).toEqual({ changes: [], warnings: [] });
    expect(target.prepare("SELECT COUNT(*) AS count FROM auth_profile_stores").get()).toEqual({
      count: 1,
    });
    expect(target.prepare("SELECT COUNT(*) AS count FROM auth_profile_state").get()).toEqual({
      count: 1,
    });
  });
});
