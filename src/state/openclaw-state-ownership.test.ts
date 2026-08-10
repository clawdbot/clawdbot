import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorStateSqliteCompact } from "../commands/doctor-state-sqlite-compact.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
} from "../config/io.health-state.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "./openclaw-state-db-startup-checkpoint.js";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchemaIfNeeded,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "./openclaw-state-ownership-operations.js";
import {
  inspectOpenClawStateOwnershipAtPath,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
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

describe("external shared-state ownership", () => {
  it("preserves ordinary unowned database behavior", () => {
    const env = createEnv();
    const database = openOpenClawStateDatabase({ env });
    expect(database.db.isOpen).toBe(true);
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toBeNull();
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

    expect(snapshotSqliteFamily(fixture.databasePath)).toEqual(before);
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

  it("fences Doctor repair, startup checkpoint, compaction, and config health", async () => {
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
    expect(() => readConfigHealthStateFromStore(healthDeps)).toThrow(OpenClawStateOwnershipError);
    expect(() =>
      writeConfigHealthStateToStore(healthDeps, {
        entries: { "/tmp/openclaw.json": { lastObservedSuspiciousSignature: "test" } },
      }),
    ).toThrow(OpenClawStateOwnershipError);
    expect(snapshotSqliteFamily(fixture.databasePath)).toEqual(before);
  });

  it("allows read-only access without the external marker", async () => {
    const fixture = claimFixture();
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env: fixture.unmarkedEnv });
    expect(database?.db.isOpen).toBe(true);
    database?.walMaintenance.close();
  });
});
