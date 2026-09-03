import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import * as persisted from "../agents/auth-profiles/persisted.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import * as paths from "../agents/auth-profiles/shared-main-dir.js";
import * as sqlite from "../agents/auth-profiles/sqlite.js";
import * as authState from "../agents/auth-profiles/state.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/upsert-with-lock.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as doctor from "./state-migrations.doctor.js";
import * as migration from "./state-migrations.shared-auth-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ownerStates: OpenClawTestState[] = [];

function makeStore(profileId: string, key: string) {
  return {
    version: 1,
    profiles: {
      [profileId]: { type: "api_key" as const, provider: "openai", key },
    },
  };
}

describe("shared auth store relocation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    sqlite.closeAuthProfileReadPool();
    closeOpenClawAgentDatabasesForTest();
    stateDb.closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    for (const state of ownerStates.splice(0).toReversed()) {
      await state.cleanup();
      expect(fs.existsSync(state.root)).toBe(false);
    }
  });

  async function createFixture() {
    const stateDir = tempDirs.make("openclaw-shared-auth-relocate-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
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
      migration,
      stateDb,
    };
  }

  async function createEmptyFixture(createSourceDatabase: boolean) {
    const stateDir = tempDirs.make("openclaw-shared-auth-empty-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
    const sourcePath = sqlite.resolveAuthProfileDatabasePath(mainAgentDir);
    if (createSourceDatabase) {
      sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, mainAgentDir);
      sqlite.deletePersistedAuthProfileStoreRaw(mainAgentDir);
    }
    return { env, stateDir, sourcePath, ownership, sqlite, migration };
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
      const effective = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      return JSON.stringify({
        credentials: persisted.buildPersistedAuthProfileSecretsStore(effective),
        state: authState.buildPersistedAuthProfileState(effective),
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
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
        )
        .get(),
    ).toEqual({ value_json: JSON.stringify(fixture.sharedStore) });
    expect(
      database
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.state'",
        )
        .get(),
    ).toEqual({ value_json: JSON.stringify(fixture.sharedState) });
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

  it("preserves post-relocation main-agent order state without treating it as legacy", async () => {
    const fixture = await createEmptyFixture(false);
    const mainAgentDir = path.dirname(fixture.sourcePath);
    const profileId = "openai:shared";
    await upsertAuthProfileWithLockOrThrow({
      profileId,
      credential: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENCLAW_SHARED_AUTH_TEST_KEY" },
      },
      stateDir: fixture.stateDir,
    });
    await setAuthProfileOrder({ agentDir: mainAgentDir, provider: "openai", order: [profileId] });
    const localBefore = {
      store: fixture.sqlite.readPersistedAuthProfileStoreRaw(mainAgentDir),
      state: fixture.sqlite.readPersistedAuthProfileStateRaw(mainAgentDir),
    };
    expect(localBefore).toEqual({
      store: { version: 1, profiles: {} },
      state: { version: 1, order: { openai: [profileId] } },
    });
    const sharedBefore = {
      store: fixture.sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env),
      state: fixture.sqlite.readPersistedSharedAuthProfileStateRaw(fixture.env),
    };

    const detected = fixture.migration.detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
    });

    expect(detected).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
    expect(
      await fixture.migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
        env: fixture.env,
      }),
    ).toEqual({ changes: [], warnings: [] });
    expect({
      store: fixture.sqlite.readPersistedAuthProfileStoreRaw(mainAgentDir),
      state: fixture.sqlite.readPersistedAuthProfileStateRaw(mainAgentDir),
    }).toEqual(localBefore);
    expect({
      store: fixture.sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env),
      state: fixture.sqlite.readPersistedSharedAuthProfileStateRaw(fixture.env),
    }).toEqual(sharedBefore);
  });

  it.each([
    "identical subset",
    "older subset",
    "empty subset",
    "changed credential",
    "source-only profile",
    "malformed source",
    "malformed target",
    "malformed target profile",
    "changed metadata",
    "changed state",
  ])("verifies a richer target against a %s before cleanup", async (scenario) => {
    const fixture = await createFixture();
    const sourcePath = fixture.sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const source = new DatabaseSync(sourcePath);
    try {
      const target = fixture.stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
      const sourceStore =
        scenario === "empty subset" ? { version: 1, profiles: {} } : fixture.sharedStore;
      const escapedProfileId = 'a"\nprofile';
      if (scenario === "changed credential") {
        Object.assign(sourceStore.profiles, makeStore(escapedProfileId, "shared-key").profiles);
      }
      const sourceJson =
        scenario === "malformed source"
          ? '{"version":1,"profiles":{"bad":null}}'
          : JSON.stringify(sourceStore);
      source
        .prepare(
          "UPDATE auth_profile_store SET store_json = ?, updated_at = 100 WHERE store_key = 'primary'",
        )
        .run(sourceJson);
      const sourceRow = source
        .prepare(
          "SELECT store_json, updated_at FROM auth_profile_store WHERE store_key = 'primary'",
        )
        .get();
      const stateRow = source
        .prepare(
          "SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = 'primary'",
        )
        .get() as { state_json: string; updated_at: number };
      const targetStore = {
        profiles: {
          ...makeStore("openai:extra", "extra-key").profiles,
          ...(scenario === "malformed target profile" ? { bad: null } : {}),
          ...(scenario === "source-only profile"
            ? {}
            : makeStore(
                "openai:shared",
                scenario === "changed credential" ? "different-key" : "shared-key",
              ).profiles),
        },
        version: 1,
        ...(scenario === "changed metadata" ? { legacyMetadata: "keep" } : {}),
      };
      const targetRow = {
        value_json:
          scenario === "malformed target"
            ? '{"version":1,"profiles":null}'
            : JSON.stringify(targetStore),
        updated_at_ms: scenario === "identical subset" ? 100 : 200,
      };
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store', ?, ?)")
        .run(targetRow.value_json, targetRow.updated_at_ms);
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, ?)")
        .run(
          stateRow.state_json,
          stateRow.updated_at + Number(["changed state", "changed credential"].includes(scenario)),
        );

      const detected = fixture.migration.detectSharedAuthStoreMigration({
        stateDir: fixture.stateDir,
        doctorOnlyStateMigrations: true,
      });
      const result = await fixture.migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
      });
      const converges = scenario.endsWith("subset");
      expect(result.warnings).toEqual(
        converges ? [] : [expect.stringMatching(/conflict.*Back up/)],
      );
      const conflictDetails: Record<string, string> = {
        "changed credential": '"openai:shared": credential differs',
        "source-only profile": '"openai:shared": missing from target',
        "malformed source": '"bad": malformed credential',
        "malformed target": "invalid credential payload",
        "malformed target profile": '"bad": malformed credential',
        "changed metadata": "store metadata differs",
        "changed state": "auth_profile_state[primary] -> config_machine_state[authProfiles.state]",
      };
      if (!converges) {
        expect(result.warnings[0]).toContain(conflictDetails[scenario]);
        expect(result.warnings[0]).toContain("openclaw doctor --fix");
        expect(result.warnings[0]).toContain(JSON.stringify(sourcePath));
        expect(result.warnings[0]).toContain(
          JSON.stringify(path.join(fixture.stateDir, "state", "openclaw.sqlite")),
        );
        expect(result.warnings[0]).not.toMatch(/shared-key|extra-key|different-key|legacyMetadata/);
      }
      expect(
        target
          .prepare(
            "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'authProfiles.store'",
          )
          .get(),
      ).toEqual(targetRow);
      expect(
        source
          .prepare(
            "SELECT store_json, updated_at FROM auth_profile_store WHERE store_key = 'primary'",
          )
          .get(),
      ).toEqual(converges ? undefined : sourceRow);
      expect(
        source
          .prepare(
            "SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = 'primary'",
          )
          .get(),
      ).toEqual(converges ? undefined : stateRow);
      const receipt = target
        .prepare(
          "SELECT source_sha256, source_record_count, status, removed_source FROM migration_sources WHERE target_table = 'auth_profile_stores'",
        )
        .get();
      expect(receipt).toEqual(
        converges
          ? {
              source_sha256: createHash("sha256").update(JSON.stringify(sourceRow)).digest("hex"),
              source_record_count: 1,
              status: "completed",
              removed_source: 1,
            }
          : undefined,
      );
      expect(
        fixture.migration.detectSharedAuthStoreMigration({
          stateDir: fixture.stateDir,
          doctorOnlyStateMigrations: true,
        }).hasLegacy,
      ).toBe(!converges);
      if (scenario === "changed credential") {
        const warning = result.warnings[0]!;
        expect(warning).toContain(`${JSON.stringify(escapedProfileId)}: missing from target`);
        expect(warning.indexOf(JSON.stringify(escapedProfileId))).toBeLessThan(
          warning.indexOf('"openai:shared"'),
        );
        expect(warning).toContain(conflictDetails["changed state"]);
        expect(warning).not.toContain("\n");
        // Follow the diagnostic: retain target-only profiles and reconcile both conflicting rows.
        target
          .prepare(
            "UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'",
          )
          .run(
            JSON.stringify({
              ...targetStore,
              profiles: { ...targetStore.profiles, ...sourceStore.profiles },
            }),
          );
        target
          .prepare(
            "UPDATE config_machine_state SET updated_at_ms = ? WHERE state_key = 'authProfiles.state'",
          )
          .run(stateRow.updated_at);
        expect(
          await fixture.migration.migrateSharedAuthStore({ detected, stateDir: fixture.stateDir }),
        ).toMatchObject({
          warnings: [],
          changes: [expect.stringContaining("Relocated shared auth")],
        });
        expect(fixture.sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual({
          ...targetStore,
          profiles: { ...targetStore.profiles, ...sourceStore.profiles },
        });
        expect(
          fixture.migration.detectSharedAuthStoreMigration({
            stateDir: fixture.stateDir,
            doctorOnlyStateMigrations: true,
          }).hasLegacy,
        ).toBe(false);
      }
    } finally {
      source.close();
    }
  });

  it("preserves post-relocation main-agent credential overrides without a receipt", async () => {
    const fixture = await createEmptyFixture(false);
    const mainAgentDir = path.dirname(fixture.sourcePath);
    const profileId = "openai:shared";
    await upsertAuthProfileWithLockOrThrow({
      profileId,
      credential: { type: "api_key", provider: "openai", key: "shared-key" },
      stateDir: fixture.stateDir,
    });
    const localStore = makeStore(profileId, "local-override-key");
    saveAuthProfileStore(localStore, mainAgentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });

    const detected = fixture.migration.detectSharedAuthStoreMigration({
      stateDir: fixture.stateDir,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
    });

    expect(detected).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
    expect(
      await fixture.migration.migrateSharedAuthStore({
        detected,
        stateDir: fixture.stateDir,
        env: fixture.env,
      }),
    ).toEqual({ changes: [], warnings: [] });
    expect(fixture.sqlite.readPersistedAuthProfileStoreRaw(mainAgentDir)).toEqual(localStore);
    expect(fixture.sqlite.readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual(
      makeStore(profileId, "shared-key"),
    );
  });

  it.each(["absolute", "tilde"] as const)(
    "detects and relocates only the selected env's %s shared auth source",
    async (pathStyle) => {
      const createOwner = async () => {
        const owner = await createOpenClawTestState({
          prefix: "openclaw-shared-auth-source-owner-",
          layout: "split",
          applyEnv: false,
          env: {
            OPENCLAW_AGENT_DIR: undefined,
            PI_CODING_AGENT_DIR: undefined,
            OPENCLAW_OAUTH_DIR: undefined,
          },
        });
        ownerStates.push(owner);
        return owner;
      };
      const selected = await createOwner();
      const ambient = await createOwner();
      const selectedDir = path.join(selected.home, "relocated-auth");
      const ambientDir = path.join(ambient.home, "relocated-auth");
      const selectedEnv = {
        ...selected.env,
        OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : selectedDir,
      };
      const ambientEnv = {
        ...ambient.env,
        OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : ambientDir,
      };
      ambient.applyEnv();
      vi.stubEnv("OPENCLAW_AGENT_DIR", ambientEnv.OPENCLAW_AGENT_DIR);
      const profileId = "openai:source";
      const selectedStore = makeStore(profileId, `fake-selected-${randomUUID()}`);
      const ambientStore = makeStore(profileId, `fake-ambient-${randomUUID()}`);
      const selectedState = { version: 1, usageStats: { [profileId]: { lastUsed: 20 } } };
      const ambientState = { version: 1, usageStats: { [profileId]: { lastUsed: 10 } } };
      for (const source of [
        { agentDir: selectedDir, env: selectedEnv, store: selectedStore, state: selectedState },
        { agentDir: ambientDir, env: ambientEnv, store: ambientStore, state: ambientState },
      ]) {
        sqlite.runAuthProfileWriteTransaction(
          source.agentDir,
          (database) => {
            sqlite.writePersistedAuthProfileStoreRaw(source.store, source.agentDir, database);
            sqlite.writePersistedAuthProfileStateRaw(source.state, source.agentDir, database);
          },
          { env: source.env },
        );
        expect(sqlite.readPersistedAuthProfileStoreRaw(source.agentDir)).toEqual(source.store);
        expect(sqlite.readPersistedAuthProfileStateRaw(source.agentDir)).toEqual(source.state);
      }

      const detected = await doctor.detectLegacyStateMigrations({
        cfg: { plugins: { enabled: false } },
        env: selectedEnv,
        homedir: () => selected.home,
        doctorOnlyStateMigrations: true,
        pluginSessionStoreAgentIds: [],
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(detected.stateDir).toBe(selected.stateDir);
      expect(detected.stateSchema.hasLegacy).toBe(false);
      const selectedSourcePath = sqlite.resolveAuthProfileDatabasePath(selectedDir);
      expect.soft(detected.sharedAuthStore).toEqual({
        sourcePath: selectedSourcePath,
        hasLegacy: true,
      });
      const result = await migration.migrateSharedAuthStore({
        detected: detected.sharedAuthStore,
        stateDir: detected.stateDir,
        env: selectedEnv,
      });

      expect.soft(result.warnings).toEqual([]);
      expect
        .soft(sqlite.readPersistedSharedAuthProfileStoreRaw(selectedEnv))
        .toEqual(selectedStore);
      expect
        .soft(sqlite.readPersistedSharedAuthProfileStateRaw(selectedEnv))
        .toEqual(selectedState);
      expect.soft(sqlite.readPersistedAuthProfileStoreRaw(selectedDir)).toBeNull();
      expect.soft(sqlite.readPersistedAuthProfileStateRaw(selectedDir)).toBeNull();
      expect.soft(sqlite.readPersistedAuthProfileStoreRaw(ambientDir)).toEqual(ambientStore);
      expect.soft(sqlite.readPersistedAuthProfileStateRaw(ambientDir)).toEqual(ambientState);
      const receipts = stateDb
        .openOpenClawStateDatabase({ env: selectedEnv })
        .db.prepare("SELECT source_path, status, removed_source FROM migration_sources")
        .all();
      expect.soft(receipts).toHaveLength(2);
      for (const receipt of receipts) {
        expect.soft(receipt).toEqual({
          source_path: selectedSourcePath,
          status: "completed",
          removed_source: 1,
        });
      }
    },
  );

  it("defers shared auth inspection while the selected state schema needs repair", async () => {
    const fixture = await createEmptyFixture(false);
    const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const legacyDatabase = new DatabaseSync(stateDatabasePath);
    try {
      legacyDatabase.exec(`
        CREATE TABLE agent_databases (
          agent_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER
        );
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
    } finally {
      legacyDatabase.close();
    }
    const stateBytes = fs.readFileSync(stateDatabasePath);
    const sourceBytes = "not a SQLite database";
    fs.mkdirSync(path.dirname(fixture.sourcePath), { recursive: true });
    fs.writeFileSync(fixture.sourcePath, sourceBytes);
    const ambientStateDir = tempDirs.make("openclaw-shared-auth-pending-ambient-");
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(ambientStateDir, "relocated-auth"));

    const detected = await doctor.detectLegacyStateMigrations({
      cfg: { plugins: { enabled: false } },
      env: fixture.env,
      doctorOnlyStateMigrations: true,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(detected.stateDir).toBe(fixture.stateDir);
    expect(detected.stateSchema.hasLegacy).toBe(true);
    expect(detected.sharedAuthStore).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
    expect(fs.readFileSync(fixture.sourcePath, "utf8")).toBe(sourceBytes);
    expect(fs.readFileSync(stateDatabasePath)).toEqual(stateBytes);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
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
      const targetStoreJson =
        crashState === "flipped-cleaned-not-finalized"
          ? JSON.stringify({
              ...fixture.sharedStore,
              profiles: {
                ...fixture.sharedStore.profiles,
                ...makeStore("openai:extra", "extra-key").profiles,
              },
            })
          : sourceStore.store_json;
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store', ?, ?)")
        .run(targetStoreJson, sourceStore.updated_at);
      target
        .prepare("INSERT INTO config_machine_state VALUES ('authProfiles.state', ?, ?)")
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
             VALUES (?, 'shared-auth-store-state-db', ?, 'auth_profile_stores', ?,
                     NULL, 1, ?, 'ownership-flipped', 1, 0, '{}')`,
          )
          .run(
            sourceKey,
            sourcePath,
            createHash("sha256").update(JSON.stringify(sourceStore)).digest("hex"),
            runId,
          );
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
      if (crashState === "flipped-cleaned-not-finalized") {
        expect(
          target
            .prepare(
              "SELECT source_sha256, source_record_count, status, removed_source FROM migration_sources WHERE target_table = 'auth_profile_stores'",
            )
            .get(),
        ).toEqual({
          source_sha256: createHash("sha256").update(JSON.stringify(sourceStore)).digest("hex"),
          source_record_count: 1,
          status: "completed",
          removed_source: 1,
        });
        expect(
          target
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'",
            )
            .get(),
        ).toEqual({ value_json: targetStoreJson });
      }
      expect(
        target
          .prepare(
            `SELECT COUNT(*) AS count FROM config_machine_state
              WHERE state_key = 'authProfiles.store'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        target
          .prepare(
            `SELECT COUNT(*) AS count FROM config_machine_state
              WHERE state_key = 'authProfiles.state'`,
          )
          .get(),
      ).toEqual({ count: 1 });
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
