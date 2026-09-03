import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { runDoctorStateSqliteCompact } from "../commands/doctor-state-sqlite-compact.js";
import { planPristineStartupStateMigrations } from "../commands/doctor/shared/pristine-startup-state.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
} from "../config/io.health-state.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { requireNodeSqlite, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import * as sqliteReadonlyLocation from "../infra/sqlite-readonly-location.js";
import { resolveStateLifecycleRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "./openclaw-state-ownership-operations.js";
import {
  assertOpenClawStateWriteAllowedAtPath,
  inspectOpenClawStateOwnershipAtPath,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
  runWithOpenClawStateOwnershipCoordinator,
  runWithOpenClawStateWriteAccess,
  STATE_SUPERVISION_KEY,
} from "./openclaw-state-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createEnv(external = false): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-ownership-"),
    ...(external ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
}

function withoutExternalMarker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.OPENCLAW_SUPERVISOR_MODE;
  return next;
}

function claimFixture(managerId = "gateway-supervisor") {
  const externalEnv = createEnv(true);
  const ownership = claimOpenClawStateOwnership(managerId, { env: externalEnv });
  const databasePath = openOpenClawStateDatabase({ env: externalEnv }).path;
  closeOpenClawStateDatabaseForTest();
  return { databasePath, externalEnv, ownership, unmarkedEnv: withoutExternalMarker(externalEnv) };
}

// Compare snapshots with Node: Vitest expands every Buffer byte into a JavaScript entry.
function snapshotSqliteFamily(databasePath: string) {
  const directory = path.dirname(databasePath);
  const entries = fs.readdirSync(directory).toSorted();
  return {
    entries,
    files: Object.fromEntries(
      entries.map((entry) => {
        const pathname = path.join(directory, entry);
        const stat = fs.statSync(pathname, { bigint: true });
        return [
          entry,
          {
            bytes: fs.readFileSync(pathname),
            birthtimeNs: stat.birthtimeNs,
            ctimeNs: stat.ctimeNs,
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            mtimeNs: stat.mtimeNs,
            size: stat.size,
          },
        ];
      }),
    ),
  };
}

function resolveExpectedOwnershipCoordinatorPath(databasePath: string): string {
  const canonicalDatabasePath = resolvePathViaExistingAncestorSync(databasePath);
  const runtimeDirectory = resolveStateLifecycleRuntimeDirectory(databasePath);
  const canonicalRuntimeDirectory = resolvePathViaExistingAncestorSync(runtimeDirectory);
  const suffix =
    typeof process.getuid === "function"
      ? `openclaw-state-locks-${process.getuid()}`
      : "openclaw-state-locks";
  return path.join(
    canonicalRuntimeDirectory,
    suffix,
    `state-lifecycle.${sha256HexPrefixCore(canonicalDatabasePath, 8)}.lock.sqlite`,
  );
}

function mockCoordinatorRollbackFailure(onRollback?: () => void) {
  const { DatabaseSync } = requireNodeSqlite();
  const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
    | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
    | undefined;
  if (!originalExec) {
    throw new Error("DatabaseSync.exec descriptor is unavailable");
  }
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: import("node:sqlite").DatabaseSync,
    sql: string,
  ) {
    if (sql === "ROLLBACK") {
      onRollback?.();
      throw new Error("simulated coordinator rollback failure");
    }
    return originalExec.call(this, sql);
  });
}

describe("external shared-state ownership", () => {
  it("returns unowned for a missing path without creating its state tree", async () => {
    const rootDir = tempDirs.make("openclaw-state-ownership-missing-");
    const missingStateDir = path.join(rootDir, "missing-state");
    const databasePath = path.join(missingStateDir, "state", "openclaw.sqlite");

    expect(fs.existsSync(missingStateDir)).toBe(false);
    expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toBeNull();
    expect(fs.existsSync(missingStateDir)).toBe(false);
    await assertOpenClawStateWriteAllowedAtPath({ databasePath });
    expect(fs.existsSync(missingStateDir)).toBe(false);
  });

  it("keeps missing-database admission eligible for pristine startup", async () => {
    const home = tempDirs.make("openclaw-state-ownership-pristine-");
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const env = {
      HOME: home,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");

    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: true,
      skipCoreStateMigrations: true,
    });
    await assertOpenClawStateWriteAllowedAtPath({ databasePath, env });
    expect(fs.readdirSync(stateDir)).toEqual(["openclaw.json"]);
    expect(planPristineStartupStateMigrations(env)).toEqual({
      skipAllStateMigrations: true,
      skipCoreStateMigrations: true,
    });
  });

  it("preserves ordinary unowned database behavior", () => {
    const env = createEnv();
    const database = openOpenClawStateDatabase({ env });
    expect(database.db.isOpen).toBe(true);
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toBeNull();
  });

  it("checks Doctor startup admission without staging a public snapshot", async () => {
    const fixture = claimFixture();
    const home = tempDirs.make("openclaw-state-ownership-doctor-");
    const snapshotStaging = vi.spyOn(sqliteReadonlyLocation, "prepareSqliteReadOnlyLocationSync");
    const runPreflight = async (env: NodeJS.ProcessEnv) =>
      await withEnvAsync(
        {
          HOME: home,
          OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
          OPENCLAW_SUPERVISOR_MODE: env.OPENCLAW_SUPERVISOR_MODE,
        },
        async () =>
          await runDoctorConfigPreflight({
            invalidConfigNote: false,
            migrateLegacyConfig: false,
            migrateState: true,
            observe: false,
            skipPristineStartupStateMigrations: true,
          }),
      );
    try {
      await expect(runPreflight(fixture.unmarkedEnv)).rejects.toThrow(OpenClawStateOwnershipError);
      await expect(runPreflight(fixture.externalEnv)).resolves.toBeDefined();
      expect(snapshotStaging).not.toHaveBeenCalled();
    } finally {
      snapshotStaging.mockRestore();
    }
  });

  it("reads ownership from a WAL when the SHM index is absent", () => {
    const env = createEnv(true);
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      const ownership = {
        version: 1,
        mode: "external",
        managerId: "wal-only-manager",
        claimedAt: 1,
      } as const;
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(STATE_SUPERVISION_KEY, JSON.stringify(ownership), ownership.claimedAt);

      const copyDir = tempDirs.make("openclaw-state-ownership-wal-only-");
      const copyPath = path.join(copyDir, "openclaw.sqlite");
      fs.copyFileSync(databasePath, copyPath);
      fs.copyFileSync(`${databasePath}-wal`, `${copyPath}-wal`);
      expect(fs.existsSync(`${copyPath}-shm`)).toBe(false);

      expect(inspectOpenClawStateOwnershipAtPath(copyPath)).toEqual(ownership);
    } finally {
      writer.close();
    }
  });

  it("rejects unmarked WAL ownership without modifying the SQLite family", async () => {
    const env = createEnv(true);
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    const ownership = {
      version: 1,
      mode: "external",
      managerId: "wal-only-manager",
      claimedAt: 1,
    } as const;
    const copyDir = tempDirs.make("openclaw-state-ownership-wal-rejection-");
    const copyPath = path.join(copyDir, "openclaw.sqlite");
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(STATE_SUPERVISION_KEY, JSON.stringify(ownership), ownership.claimedAt);
      fs.copyFileSync(databasePath, copyPath);
      fs.copyFileSync(`${databasePath}-wal`, `${copyPath}-wal`);
    } finally {
      writer.close();
    }

    expect(fs.existsSync(`${copyPath}-shm`)).toBe(false);
    const before = snapshotSqliteFamily(copyPath);
    await expect(
      assertOpenClawStateWriteAllowedAtPath({
        databasePath: copyPath,
        env: withoutExternalMarker(env),
      }),
    ).rejects.toThrow(OpenClawStateOwnershipError);
    assert.deepStrictEqual(snapshotSqliteFamily(copyPath), before);
  });

  it("observes committed ownership that is still resident in the live WAL", () => {
    const env = createEnv();
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    const ownership = {
      version: 1 as const,
      mode: "external" as const,
      managerId: "wal-supervisor",
      claimedAt: 1,
    };
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer
        .prepare(
          `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
           VALUES (?, ?, ?)`,
        )
        .run(STATE_SUPERVISION_KEY, JSON.stringify(ownership), ownership.claimedAt);
      expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(ownership);
    } finally {
      writer.close();
    }
  });

  it("keeps its snapshot stable when a WAL appears after capture", () => {
    const env = createEnv(true);
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const ownership = {
      version: 1,
      mode: "external",
      managerId: "transition-manager",
      claimedAt: 2,
    } as const;
    const { DatabaseSync } = requireNodeSqlite();
    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    let writer: InstanceType<typeof DatabaseSync> | undefined;
    let injected = false;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      if (!injected && sql.includes("PRAGMA busy_timeout")) {
        injected = true;
        writer = new DatabaseSync(databasePath);
        originalExec.call(writer, "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        writer
          .prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          )
          .run(STATE_SUPERVISION_KEY, JSON.stringify(ownership), ownership.claimedAt);
      }
      return originalExec.call(this, sql);
    });

    try {
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toBeNull();
      expect(injected).toBe(true);
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(ownership);
    } finally {
      exec.mockRestore();
      writer?.close();
    }
  });

  it("does not expose rolled-back ownership from a rollback-journal race", () => {
    const env = createEnv();
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const writer = new DatabaseSync(databasePath);
    writer.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
        "PRAGMA cache_size = 2; PRAGMA cache_spill = ON; " +
        "CREATE TABLE rollback_race_pressure (payload TEXT NOT NULL) STRICT;",
    );
    const baselineOwnership = {
      version: 1 as const,
      mode: "external" as const,
      managerId: "baseline-supervisor",
      claimedAt: 1,
    };
    const transientOwnership = {
      version: 1 as const,
      mode: "external" as const,
      managerId: "rollback-race-supervisor",
      claimedAt: 2,
    };
    const payload = JSON.stringify("x".repeat(8192));
    writer.exec("BEGIN IMMEDIATE;");
    const writeOwnership = writer.prepare(
      `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET
         value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
    );
    writeOwnership.run(
      STATE_SUPERVISION_KEY,
      JSON.stringify(baselineOwnership),
      baselineOwnership.claimedAt,
    );
    const insertPressure = writer.prepare("INSERT INTO rollback_race_pressure VALUES (?)");
    writer.exec("COMMIT;");
    const originalGet = Object.getOwnPropertyDescriptor(StatementSync.prototype, "get")?.value as
      | ((
          this: import("node:sqlite").StatementSync,
          ...params: unknown[]
        ) => Record<string, import("node:sqlite").SQLOutputValue> | undefined)
      | undefined;
    if (!originalGet) {
      throw new Error("StatementSync.get descriptor is unavailable");
    }
    let transactionStarted = false;
    let transientOwnershipObserved = false;
    const get = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
      this: import("node:sqlite").StatementSync,
      ...params: unknown[]
    ) {
      if (!transactionStarted && params[0] === STATE_SUPERVISION_KEY) {
        transactionStarted = true;
        writer.exec("BEGIN IMMEDIATE;");
        writeOwnership.run(
          STATE_SUPERVISION_KEY,
          JSON.stringify(transientOwnership),
          transientOwnership.claimedAt,
        );
        // Fresh pages force cache misses even when SQLite's global cache retains existing rows.
        // Use another B-tree after releasing the ownership cursor; rollback discards these pages.
        for (let index = 0; index < 256; index += 1) {
          insertPressure.run(payload);
        }
        const racedReader = new DatabaseSync(resolveImmutableSqliteFileUri(databasePath), {
          readOnly: true,
        });
        try {
          const result = originalGet.call(
            racedReader.prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = ? LIMIT 1",
            ),
            STATE_SUPERVISION_KEY,
          );
          transientOwnershipObserved =
            (result as { value_json?: unknown } | undefined)?.value_json ===
            JSON.stringify(transientOwnership);
          writer.exec("ROLLBACK;");
          return originalGet.apply(this, params);
        } finally {
          racedReader.close();
        }
      }
      return originalGet.apply(this, params);
    });

    try {
      const inspected = inspectOpenClawStateOwnershipAtPath(databasePath);
      expect(transactionStarted).toBe(true);
      expect(transientOwnershipObserved).toBe(true);
      expect(inspected).toEqual(baselineOwnership);

      writer
        .prepare("DELETE FROM config_machine_state WHERE state_key = ?")
        .run(STATE_SUPERVISION_KEY);
      transactionStarted = false;
      transientOwnershipObserved = false;
      expect(
        runWithOpenClawStateWriteAccess(
          { databasePath, env },
          "rollback-journal admission test",
          () => inspectOpenClawStateOwnershipAtPath(databasePath),
        ),
      ).toBeNull();
      expect(transactionStarted).toBe(true);
      expect(transientOwnershipObserved).toBe(true);
    } finally {
      get.mockRestore();
      if (writer.isTransaction) {
        writer.exec("ROLLBACK;");
      }
      writer.close();
    }
  });

  it("inspects consolidated ownership without modifying its SQLite family or state tree", () => {
    const fixture = claimFixture();
    const stateDir = fixture.externalEnv.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("ownership fixture state directory is unavailable");
    }
    fs.rmSync(path.join(stateDir, "tmp"), { force: true, recursive: true });
    expect(fs.readdirSync(stateDir)).toEqual(["state"]);
    const before = snapshotSqliteFamily(fixture.databasePath);

    if (process.platform !== "win32") {
      fs.chmodSync(stateDir, 0o500);
    }
    try {
      expect(inspectOpenClawStateOwnershipAtPath(fixture.databasePath)).toEqual(fixture.ownership);
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(stateDir, 0o700);
      }
    }

    assert.deepStrictEqual(snapshotSqliteFamily(fixture.databasePath), before);
    expect(fs.readdirSync(stateDir)).toEqual(["state"]);
  });

  it("uses one external coordinator path across temporary-directory environments", () => {
    const env = createEnv();
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const stateDir = resolveOpenClawStateDirForDatabasePath(databasePath);
    const coordinatorPath = resolveExpectedOwnershipCoordinatorPath(databasePath);
    fs.rmSync(path.join(stateDir, "tmp"), { force: true, recursive: true });

    for (const temporaryDirectory of [
      tempDirs.make("ownership-tmp-a-"),
      tempDirs.make("ownership-tmp-b-"),
    ]) {
      withEnv({ TMPDIR: temporaryDirectory }, () =>
        runWithOpenClawStateOwnershipCoordinator(databasePath, "test coordinator path", () => {}),
      );
      expect(fs.existsSync(coordinatorPath)).toBe(true);
    }
  });

  it("closes an unpublished fresh handle when coordinator release fails", () => {
    const env = createEnv();
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
    let cachedDuringRelease: ReturnType<
      typeof openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath
    > = undefined;
    const exec = mockCoordinatorRollbackFailure(() => {
      cachedDuringRelease =
        openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath);
    });

    try {
      expect(() => openOpenClawStateDatabase({ env })).toThrow(
        /fresh state database open and coordinator release both failed/u,
      );
    } finally {
      exec.mockRestore();
    }
    expect(cachedDuringRelease).toBeUndefined();
    expect(
      openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath),
    ).toBeUndefined();
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });

  it("requires the external marker and makes claims idempotent only for one manager", () => {
    const env = createEnv();
    expect(() => claimOpenClawStateOwnership("gateway-supervisor", { env })).toThrow(
      /OPENCLAW_SUPERVISOR_MODE=external/u,
    );
    const externalEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: "external" };
    const first = claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
    expect(claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv })).toEqual(first);
    expect(
      inspectOpenClawStateOwnershipAtPath(openOpenClawStateDatabase({ env: externalEnv }).path),
    ).toEqual(first);
    expect(() => claimOpenClawStateOwnership("replacement-manager", { env: externalEnv })).toThrow(
      /already claimed by external manager gateway-supervisor/u,
    );
  });

  it("refuses unmarked writable opens before changing the SQLite family", () => {
    const fixture = claimFixture();
    const pending = openOpenClawStateDatabase({ env: fixture.externalEnv });
    pending.db.exec(`
      ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;
      DROP INDEX idx_task_runs_status;
    `);
    closeOpenClawStateDatabaseForTest();
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.databasePath, 0o666);
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(fs.existsSync(`${fixture.databasePath}${suffix}`)).toBe(false);
    }
    const before = snapshotSqliteFamily(fixture.databasePath);

    expect(() => openOpenClawStateDatabase({ env: fixture.unmarkedEnv })).toThrow(
      OpenClawStateOwnershipError,
    );

    assert.deepStrictEqual(snapshotSqliteFamily(fixture.databasePath), before);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(fs.existsSync(`${fixture.databasePath}${suffix}`)).toBe(false);
    }
    const repaired = openOpenClawStateDatabase({ env: fixture.externalEnv });
    expect(repaired.db.isOpen).toBe(true);
    expect(repaired.db.prepare("PRAGMA table_info(worktrees)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "run_end_cleanup_json" })]),
    );
    expect(
      repaired.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_task_runs_status"),
    ).toBeDefined();
  });

  it("fences a claim made immediately before cold-open schema repair", () => {
    const env = createEnv();
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      drifted.exec(`
        ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;
        DROP INDEX idx_task_runs_status;
      `);
    } finally {
      drifted.close();
    }

    const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")?.value as
      | ((this: import("node:sqlite").DatabaseSync, sql: string) => void)
      | undefined;
    if (!originalExec) {
      throw new Error("DatabaseSync.exec descriptor is unavailable");
    }
    let immediateTransactionCount = 0;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      if (sql === "BEGIN IMMEDIATE" && ++immediateTransactionCount === 1) {
        const claimant = new DatabaseSync(databasePath);
        try {
          claimant
            .prepare(
              `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
               VALUES (?, ?, ?)`,
            )
            .run(
              STATE_SUPERVISION_KEY,
              JSON.stringify({
                version: 1,
                mode: "external",
                managerId: "race-manager",
                claimedAt: 1,
              }),
              1,
            );
        } finally {
          claimant.close();
        }
      }
      return originalExec.call(this, sql);
    });

    try {
      expect(() => openOpenClawStateDatabase({ env })).toThrow(OpenClawStateOwnershipError);
    } finally {
      exec.mockRestore();
    }
    expect(immediateTransactionCount).toBe(1);

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        verify
          .prepare("SELECT 1 FROM pragma_table_info('worktrees') WHERE name = ?")
          .get("run_end_cleanup_json"),
      ).toBeUndefined();
      expect(
        verify
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
          .get("idx_task_runs_status"),
      ).toBeUndefined();
    } finally {
      verify.close();
    }
  });

  it("fences a claim made during a canonical current-schema cold open", () => {
    const env = createEnv();
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const originalPrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")
      ?.value as
      | ((
          this: import("node:sqlite").DatabaseSync,
          sql: string,
        ) => import("node:sqlite").StatementSync)
      | undefined;
    if (!originalPrepare) {
      throw new Error("DatabaseSync.prepare descriptor is unavailable");
    }
    let claimInjected = false;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: import("node:sqlite").DatabaseSync,
      sql: string,
    ) {
      if (!claimInjected && sql.includes("SELECT app_version FROM schema_meta")) {
        claimInjected = true;
        const claimant = new DatabaseSync(databasePath);
        try {
          claimant
            .prepare(
              `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
               VALUES (?, ?, ?)`,
            )
            .run(
              STATE_SUPERVISION_KEY,
              JSON.stringify({
                version: 1,
                mode: "external",
                managerId: "race-manager",
                claimedAt: 1,
              }),
              1,
            );
        } finally {
          claimant.close();
        }
      }
      return originalPrepare.call(this, sql);
    });

    try {
      expect(() => openOpenClawStateDatabase({ env })).toThrow(OpenClawStateOwnershipError);
    } finally {
      prepare.mockRestore();
    }
    expect(claimInjected).toBe(true);
  });

  it("fences injected and pre-claim handles on their next canonical write", () => {
    const externalEnv = createEnv(true);
    const opened = openOpenClawStateDatabase({ env: externalEnv });
    claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
    const unmarkedEnv = withoutExternalMarker(externalEnv);

    expect(() => openOpenClawStateDatabase({ env: unmarkedEnv })).toThrow(
      OpenClawStateOwnershipError,
    );
    expect(() => openOpenClawStateDatabase({ env: unmarkedEnv, database: opened })).toThrow(
      OpenClawStateOwnershipError,
    );
    expect(() =>
      runOpenClawStateWriteTransaction(() => undefined, {
        env: unmarkedEnv,
        database: opened,
      }),
    ).toThrow(OpenClawStateOwnershipError);
  });

  it("reports checkpoint failure and lets the same durable claim retry", () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    const checkpoint = vi.spyOn(database.walMaintenance, "checkpoint").mockReturnValueOnce(false);

    expect(() => claimOpenClawStateOwnership("gateway-supervisor", { env })).toThrow(
      /ownership was committed.*checkpoint failed/iu,
    );
    checkpoint.mockRestore();
    const ownership = claimOpenClawStateOwnership("gateway-supervisor", { env });
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toEqual(ownership);
  });

  it("reports lock cleanup separately after a durable claim and permits idempotent retry", () => {
    const env = createEnv(true);
    openOpenClawStateDatabase({ env });
    const exec = mockCoordinatorRollbackFailure();

    try {
      expect(() => claimOpenClawStateOwnership("gateway-supervisor", { env })).toThrow(
        /claim\/checkpoint completed, but releasing its coordinator failed/u,
      );
    } finally {
      exec.mockRestore();
    }
    const ownership = claimOpenClawStateOwnership("gateway-supervisor", { env });
    expect(inspectOpenClawStateOwnershipAtPath(openOpenClawStateDatabase({ env }).path)).toEqual(
      ownership,
    );
  });

  it("fails closed when unmarked and lets an external claim repair malformed metadata", () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    database.db
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(STATE_SUPERVISION_KEY, '{"version":1,"mode":"external"}', Date.now());
    database.db.exec("ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;");
    closeOpenClawStateDatabaseForTest();

    expect(() => openOpenClawStateDatabase({ env: withoutExternalMarker(env) })).toThrow(
      OpenClawStateOwnershipMetadataError,
    );
    expect(() => openOpenClawStateDatabase({ env })).toThrow(OpenClawStateOwnershipMetadataError);
    const ownership = claimOpenClawStateOwnership("gateway-supervisor", { env });
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toEqual(ownership);
    expect(
      openOpenClawStateDatabase({ env }).db.prepare("PRAGMA table_info(worktrees)").all(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "run_end_cleanup_json" })]));
  });

  it("does not repair malformed ownership before blocking schema drift", () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    const malformed = '{"version":1,"mode":"external"}';
    database.db
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(STATE_SUPERVISION_KEY, malformed, Date.now());
    database.db.exec("ALTER TABLE worktrees ADD COLUMN unexpected_claim_column TEXT DEFAULT NULL;");
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    expect(() => claimOpenClawStateOwnership("gateway-supervisor", { env })).toThrow(
      /column definitions differ for worktrees/u,
    );
    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        raw
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get(STATE_SUPERVISION_KEY),
      ).toEqual({ value_json: malformed });
    } finally {
      raw.close();
    }
  });

  it("fences state repair and config health writes while allowing health reads", async () => {
    const fixture = claimFixture();
    if (process.platform !== "win32") {
      fs.chmodSync(fixture.databasePath, 0o666);
    }
    const before = snapshotSqliteFamily(fixture.databasePath);
    expect(() => repairOpenClawStateDatabaseSchema({ env: fixture.unmarkedEnv })).toThrow(
      OpenClawStateOwnershipError,
    );
    expect(() => repairOpenClawStateDatabaseSchemaIfNeeded({ env: fixture.unmarkedEnv })).toThrow(
      OpenClawStateOwnershipError,
    );
    expect(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, {
        env: fixture.unmarkedEnv,
      }),
    ).toThrow(OpenClawStateOwnershipError);
    await expect(runDoctorStateSqliteCompact({ env: fixture.unmarkedEnv })).rejects.toThrow(
      OpenClawStateOwnershipError,
    );
    const healthDeps = {
      env: fixture.unmarkedEnv,
      homedir: () => fixture.unmarkedEnv.OPENCLAW_STATE_DIR ?? "",
      logger: { warn: () => undefined },
    };
    expect(readConfigHealthStateFromStore(healthDeps)).toEqual({ entries: {} });
    expect(() =>
      writeConfigHealthStateToStore(healthDeps, {
        entries: { "/tmp/openclaw.json": { lastObservedSuspiciousSignature: "test" } },
      }),
    ).toThrow(OpenClawStateOwnershipError);
    assert.deepStrictEqual(snapshotSqliteFamily(fixture.databasePath), before);
  });

  it("allows read-only access without the external marker", async () => {
    const fixture = claimFixture();
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env: fixture.unmarkedEnv });
    expect(database?.db.isOpen).toBe(true);
    database?.walMaintenance.close();
  });
});
