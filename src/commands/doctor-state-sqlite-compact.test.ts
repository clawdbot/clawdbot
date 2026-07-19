import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.generated.js";
import { runDoctorStateSqliteCompact } from "./doctor-state-sqlite-compact.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabase();
    cleanup();
  });
});
type DoctorStateSqliteCompactReport = Awaited<ReturnType<typeof runDoctorStateSqliteCompact>>;
type CompletedStateSqliteCompactReport = Extract<
  DoctorStateSqliteCompactReport,
  { skipped: false }
>;

function createStateEnv(): NodeJS.ProcessEnv {
  const stateDir = tempDirs.make("openclaw-state-compact-");
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

function seedStateDatabase(params: {
  env: NodeJS.ProcessEnv;
  role?: string;
  schemaVersion?: number;
  withBloat?: boolean;
}): string {
  const sqlitePath = resolveOpenClawStateSqlitePath(params.env);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  const schemaVersion = params.schemaVersion ?? OPENCLAW_STATE_SCHEMA_VERSION;
  try {
    database.exec(`
      PRAGMA auto_vacuum = NONE;
      PRAGMA journal_mode = WAL;
      ${OPENCLAW_STATE_SCHEMA_SQL}
      CREATE TABLE compact_payload (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
      PRAGMA user_version = ${schemaVersion};
    `);
    database
      .prepare(
        `
          INSERT INTO schema_meta (
            meta_key,
            role,
            schema_version,
            agent_id,
            app_version,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, NULL, NULL, 1, 1)
        `,
      )
      .run("primary", params.role ?? "global", schemaVersion);
    if (params.withBloat) {
      const insert = database.prepare("INSERT INTO compact_payload (payload) VALUES (?)");
      database.exec("BEGIN IMMEDIATE;");
      for (let index = 0; index < 512; index += 1) {
        insert.run(`${index}:${"x".repeat(8_192)}`);
      }
      database.exec("COMMIT; DELETE FROM compact_payload; PRAGMA wal_checkpoint(TRUNCATE);");
    }
  } finally {
    database.close();
  }
  if (process.platform !== "win32") {
    fs.chmodSync(sqlitePath, 0o666);
  }
  return sqlitePath;
}

function readPragma(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name};`).get() as Record<string, unknown>;
  return Number(row[name] ?? Object.values(row)[0]);
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    database.exec(`PRAGMA schema_version = ${readPragma(database, "schema_version") + 1};`);
  } finally {
    database.close();
  }
}

function expectCompletedReport(
  report: DoctorStateSqliteCompactReport,
): asserts report is CompletedStateSqliteCompactReport {
  expect(report.skipped).toBe(false);
  if (report.skipped) {
    throw new Error("expected state SQLite compaction report");
  }
}

function expectOwnerOnlySqlitePermissions(sqlitePath: string): void {
  expect(fs.statSync(path.dirname(sqlitePath)).mode & 0o777).toBe(0o700);
  for (const candidate of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (fs.existsSync(candidate)) {
      expect(fs.statSync(candidate).mode & 0o777).toBe(0o600);
    }
  }
}

describe("runDoctorStateSqliteCompact", () => {
  it("reports a missing canonical database as skipped", async () => {
    const env = createStateEnv();

    await expect(runDoctorStateSqliteCompact({ env })).resolves.toEqual({
      mode: "compact",
      path: resolveOpenClawStateSqlitePath(env),
      reason: "missing",
      skipped: true,
    });
  });

  it("compacts the canonical database and reports verified before/after state", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });

    const report = await runDoctorStateSqliteCompact({ env });

    expectCompletedReport(report);
    expect(report.path).toBe(sqlitePath);
    expect(report.before.autoVacuum).toBe(0);
    expect(report.after.autoVacuum).toBe(2);
    expect(report.before.freelistPages).toBeGreaterThan(0);
    expect(report.after.freelistPages).toBe(0);
    expect(report.after.dbSizeBytes).toBeLessThan(report.before.dbSizeBytes);
    expect(report.after.walSizeBytes).toBe(0);
    expect(report.after.pageSizeBytes).toBeGreaterThan(0);
    expect(report.reclaimedBytes).toBeGreaterThan(0);
    expect(report.integrityCheck).toBe("ok");
  });

  it("clears authoritative quarantine after compaction", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "state",
        path: sqlitePath,
        reason: "corrupt index",
      }),
    ).toBe(true);

    await runDoctorStateSqliteCompact({ env });

    expect(readOpenClawDatabaseQuarantine(sqlitePath, { env })).toBeUndefined();
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reapplies owner-only SQLite permissions", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });

    await runDoctorStateSqliteCompact({ env });

    expectOwnerOnlySqlitePermissions(sqlitePath);
  });

  it("rejects non-global schema metadata before mutation", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, role: "agent", withBloat: true });

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(/schema role agent.*global/);

    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(readPragma(database, "auto_vacuum")).toBe(0);
      expect(readPragma(database, "freelist_count")).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it.each([
    ["legacy", OPENCLAW_STATE_SCHEMA_VERSION - 1, /doctor --fix before compacting/],
    ["future", OPENCLAW_STATE_SCHEMA_VERSION + 1, /uses newer schema version/],
  ] as const)(
    "rejects a %s shared-state schema before mutation",
    async (_label, schemaVersion, message) => {
      const env = createStateEnv();
      const sqlitePath = seedStateDatabase({ env, schemaVersion });

      await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(message);

      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(readPragma(database, "auto_vacuum")).toBe(0);
      } finally {
        database.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the canonical database path",
    async () => {
      const env = createStateEnv();
      const canonicalPath = resolveOpenClawStateSqlitePath(env);
      const externalEnv = createStateEnv();
      const externalPath = seedStateDatabase({ env: externalEnv });
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
      fs.symlinkSync(externalPath, canonicalPath);

      await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(/not a regular file/);
    },
  );

  it("refuses compaction while this process owns an open shared-state handle", async () => {
    const env = createStateEnv();
    openOpenClawStateDatabase({ env });

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
      /already open in this process/,
    );
  });

  it("leaves the database untouched when exclusive state ownership is unavailable", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });

    await expect(
      runDoctorStateSqliteCompact(
        { env },
        {
          withMaintenanceLock: async () => {
            throw new Error("Gateway owns this OpenClaw state directory");
          },
        },
      ),
    ).rejects.toThrow(/Gateway owns/);

    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(readPragma(database, "auto_vacuum")).toBe(0);
      expect(readPragma(database, "freelist_count")).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("treats a busy truncating checkpoint as failure", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env });
    const sqlite = requireNodeSqlite();
    const reader = new sqlite.DatabaseSync(sqlitePath);
    const writer = new sqlite.DatabaseSync(sqlitePath);
    try {
      reader.exec("BEGIN; SELECT COUNT(*) FROM compact_payload;");
      writer.exec("INSERT INTO compact_payload (payload) VALUES ('newer wal frame');");

      // Exercise the real busy checkpoint result without waiting the production lock timeout.
      await expect(runDoctorStateSqliteCompact({ env }, { busyTimeoutMs: 0 })).rejects.toThrow(
        /checkpoint remained busy/,
      );
      expect(readPragma(writer, "auto_vacuum")).toBe(0);
    } finally {
      reader.exec("ROLLBACK;");
      reader.close();
      writer.close();
    }
  });

  it("rejects stale secondary indexes before mutating the database", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });
    createUnsafeIndexDrift(sqlitePath);
    const sqlite = requireNodeSqlite();
    const before = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(before.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(before.prepare("PRAGMA integrity_check").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/missing from index unsafe_index_records_value/),
          }),
        ]),
      );
    } finally {
      before.close();
    }

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );

    const after = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(readPragma(after, "auto_vacuum")).toBe(0);
      expect(readPragma(after, "freelist_count")).toBeGreaterThan(0);
      expect(after.prepare("PRAGMA integrity_check").all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            integrity_check: expect.stringMatching(/missing from index unsafe_index_records_value/),
          }),
        ]),
      );
    } finally {
      after.close();
    }
  });

  it("rejects foreign-key violations before mutating the database", async () => {
    const env = createStateEnv();
    const sqlitePath = seedStateDatabase({ env, withBloat: true });
    const sqlite = requireNodeSqlite();
    const corrupted = new sqlite.DatabaseSync(sqlitePath);
    try {
      corrupted.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE compact_parents (id INTEGER PRIMARY KEY);
        CREATE TABLE compact_children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES compact_parents(id)
        );
        INSERT INTO compact_children (id, parent_id) VALUES (1, 99);
      `);
      expect(corrupted.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "compact_children",
        rowid: 1,
        parent: "compact_parents",
        fkid: 0,
      });
    } finally {
      corrupted.close();
    }

    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(
      /foreign_key_check failed.*compact_children row 1 references compact_parents \(foreign key 0\)/iu,
    );

    const after = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(readPragma(after, "auto_vacuum")).toBe(0);
      expect(readPragma(after, "freelist_count")).toBeGreaterThan(0);
      expect(after.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "compact_children",
        rowid: 1,
        parent: "compact_parents",
        fkid: 0,
      });
    } finally {
      after.close();
    }
  });
});
