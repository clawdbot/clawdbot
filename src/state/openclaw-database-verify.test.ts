import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  recordOpenClawAgentDatabaseOpenFailure,
} from "./openclaw-agent-db.js";
import {
  applyOpenClawDatabaseVerificationResults,
  runDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import {
  type OpenClawDatabaseVerifyTarget,
  verifyOpenClawDatabases,
} from "./openclaw-database-verify.worker.js";
import {
  clearOpenClawDatabaseQuarantine,
  readOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "./openclaw-quarantine-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => cleanupTempDirs(tempDirs));

function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
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
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function repairUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

async function copyHealthyDatabase(sourcePath: string, targetPath: string): Promise<void> {
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqlite.backup(source, targetPath);
  } finally {
    source.close();
  }
}

function quarantineStorePath(stateDir: string): string {
  return path.join(stateDir, "state", "openclaw-quarantine.sqlite");
}

describe("OpenClaw database integrity verifier", () => {
  it("detects corruption off-thread, quarantines it, and latches later opens", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];

    const directResults = await verifyOpenClawDatabases(targets);
    expect(directResults).toEqual([
      {
        path: agentPath,
        ok: false,
        error: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
        terminal: true,
      },
    ]);
    await expect(runDatabaseVerifyWorker(targets)).resolves.toEqual(directResults);

    applyOpenClawDatabaseVerificationResults({
      env,
      results: directResults,
      targets,
    });
    const quarantine = readOpenClawDatabaseQuarantine(agentPath, { env });
    expect(quarantine).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
    });

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(quarantine?.reason ?? ""),
      }),
    );
    clearOpenClawAgentDatabaseOpenFailure(agentPath, { env });
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a healthy database that replaced the verified file", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-replacement-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const healthyReplacementPath = `${agentPath}.healthy`;
    const corruptArchivePath = `${agentPath}.corrupt`;
    fs.copyFileSync(agentPath, healthyReplacementPath);
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];
    const results = await verifyOpenClawDatabases(targets);
    expect(results).toEqual([
      expect.objectContaining({
        path: agentPath,
        ok: false,
        terminal: true,
      }),
    ]);

    fs.renameSync(agentPath, corruptArchivePath);
    fs.renameSync(healthyReplacementPath, agentPath);
    applyOpenClawDatabaseVerificationResults({ env, results, targets });

    expect(readOpenClawDatabaseQuarantine(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt agent inode is cached",
    async () => {
      const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-live-agent-replace-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      const healthyReplacementPath = `${agent.path}.healthy`;
      const corruptArchivePath = `${agent.path}.corrupt`;
      await copyHealthyDatabase(agent.path, healthyReplacementPath);
      createUnsafeIndexDrift(agent.path);
      const targets: OpenClawDatabaseVerifyTarget[] = [
        { kind: "agent", label: "OpenClaw agent database worker-1", path: agent.path },
      ];
      const results = await verifyOpenClawDatabases(targets);

      fs.renameSync(agent.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, agent.path);
      applyOpenClawDatabaseVerificationResults({ env, results, targets });

      expect(agent.db.isOpen).toBe(false);
      expect(readOpenClawDatabaseQuarantine(agent.path, { env })).toBeUndefined();
      expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt state inode is cached",
    async () => {
      const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-live-state-replace-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const state = openOpenClawStateDatabase({ env });
      const healthyReplacementPath = `${state.path}.healthy`;
      const corruptArchivePath = `${state.path}.corrupt`;
      await copyHealthyDatabase(state.path, healthyReplacementPath);
      createUnsafeIndexDrift(state.path);
      const targets: OpenClawDatabaseVerifyTarget[] = [
        { kind: "state", label: "OpenClaw state database", path: state.path },
      ];
      const results = await verifyOpenClawDatabases(targets);

      fs.renameSync(state.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, state.path);
      applyOpenClawDatabaseVerificationResults({ env, results, targets });

      expect(state.db.isOpen).toBe(false);
      expect(readOpenClawDatabaseQuarantine(state.path, { env })).toBeUndefined();
      expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
    },
  );

  it("reconfirms and quarantines a corrupt closed database", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-closed-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];
    const results = await verifyOpenClawDatabases(targets);

    applyOpenClawDatabaseVerificationResults({ env, results, targets });

    expect(readOpenClawDatabaseQuarantine(agentPath, { env })?.reason).toMatch(
      /missing from index unsafe_index_records_value/iu,
    );
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a repaired database after same-inode mutation", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-repair-race-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];
    const results = await verifyOpenClawDatabases(targets);
    expect(results[0]).toEqual(expect.objectContaining({ ok: false, terminal: true }));

    repairUnsafeIndexDrift(agentPath);
    await expect(verifyOpenClawDatabases(targets)).resolves.toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    applyOpenClawDatabaseVerificationResults({ env, results, targets });

    expect(readOpenClawDatabaseQuarantine(agentPath, { env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("rejects stale terminal results after draining healthy owners", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-live-stale-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const state = openOpenClawStateDatabase({ env });
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "state", label: "OpenClaw state database", path: state.path },
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agent.path },
    ];

    applyOpenClawDatabaseVerificationResults({
      env,
      results: targets.map((target) => ({
        path: target.path,
        ok: false,
        error: "stale terminal result",
        terminal: true,
      })),
      targets,
    });

    expect(readOpenClawDatabaseQuarantine(state.path, { env })).toBeUndefined();
    expect(readOpenClawDatabaseQuarantine(agent.path, { env })).toBeUndefined();
    expect(state.db.isOpen).toBe(false);
    expect(agent.db.isOpen).toBe(false);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("revalidates agent schema ownership after confirmation drains a pathname", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-agent-revalidate-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agent = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const replacementPath = `${agent.path}.replacement`;
    const { DatabaseSync } = requireNodeSqlite();
    const replacement = new DatabaseSync(replacementPath);
    replacement.close();
    expect(closeOpenClawAgentDatabaseByPath(agent.path)).toBe(true);
    fs.rmSync(agent.path);
    fs.renameSync(replacementPath, agent.path);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agent.path },
    ];

    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agent.path, ok: false, error: "stale terminal result", terminal: true }],
      targets,
    });

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db
        .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1" });
  });

  it("expires a generation-bound process latch after the database changes", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-latch-generation-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    const generation = readStableSqliteFileGeneration(agentPath);
    const error = new Error("verified corrupt generation");
    error.name = "SqliteIntegrityError";

    expect(recordOpenClawAgentDatabaseOpenFailure(agentPath, error, generation)).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const changed = new DatabaseSync(agentPath);
    try {
      changed.exec("CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      changed.close();
    }

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-clear-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    openOpenClawStateDatabase({ env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: agentPath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordOpenClawAgentDatabaseOpenFailure(agentPath, error);
    closeOpenClawStateDatabaseForTest();

    const storePath = quarantineStorePath(stateDir);
    // A read-only quarantine store cannot drop the row; the clear must say so
    // instead of letting doctor report success while the next open still refuses.
    fs.chmodSync(storePath, 0o444);
    try {
      expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(false);
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          kind: "agent",
          path: agentPath,
          reason: "new reason",
        }),
      ).toBe(false);
    } finally {
      fs.chmodSync(storePath, 0o600);
    }
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("keeps healthy opens on the missing-store fast path", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-clean-");
    const env = { OPENCLAW_STATE_DIR: stateDir };

    openOpenClawStateDatabase({ env });
    openOpenClawAgentDatabase({ agentId: "worker-1", env });

    expect(fs.existsSync(quarantineStorePath(stateDir))).toBe(false);
  });

  it("records and clears dedicated quarantine rows with rollback journaling", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);

    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readOpenClawDatabaseQuarantine(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: "corrupt index",
    });

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(readSqliteNumberPragma(raw, "synchronous")).toBe(2);
      expect(readSqliteNumberPragma(raw, "user_version")).toBe(2);
    } finally {
      raw.close();
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(clearOpenClawDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(readOpenClawDatabaseQuarantine(databasePath, { env })).toBeUndefined();
  });

  it("expires a persisted quarantine when the verified database generation changes", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-store-generation-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      database.close();
    }
    const generation = readStableSqliteFileGeneration(databasePath);

    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        generation,
        kind: "agent",
        path: databasePath,
        reason: "corrupt generation",
      }),
    ).toBe(true);
    expect(readOpenClawDatabaseQuarantine(databasePath, { env })?.reason).toBe(
      "corrupt generation",
    );

    const changed = new DatabaseSync(databasePath);
    try {
      changed.exec("INSERT INTO records DEFAULT VALUES;");
    } finally {
      changed.close();
    }
    expect(readOpenClawDatabaseQuarantine(databasePath, { env })).toBeUndefined();
  });

  it("reads schema-v1 quarantine rows and migrates them on the next write", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-store-v1-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(storePath);
    try {
      legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY,
          kind TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      legacy
        .prepare(
          "INSERT INTO quarantined_databases (path, kind, reason, quarantined_at) VALUES (?, ?, ?, ?)",
        )
        .run(path.resolve(databasePath), "agent", "legacy quarantine", 1);
    } finally {
      legacy.close();
    }

    expect(readOpenClawDatabaseQuarantine(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: 1,
      reason: "legacy quarantine",
    });
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "migrated quarantine",
      }),
    ).toBe(true);

    const migrated = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
      expect(
        migrated
          .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
          .get(path.resolve(databasePath)),
      ).toEqual({ reason: "migrated quarantine", verified_generation: null });
    } finally {
      migrated.close();
    }
  });

  it("recovers an interrupted empty quarantine-store initialization", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-empty-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "", { mode: 0o600 });

    expect(readOpenClawDatabaseQuarantine(databasePath, { env })).toBeUndefined();
    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readOpenClawDatabaseQuarantine(databasePath, { env })?.reason).toBe("corrupt index");
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before reading quarantine",
    () => {
      const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-hot-journal-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(stateDir, "agent.sqlite");
      const storePath = quarantineStorePath(stateDir);
      expect(
        recordOpenClawDatabaseQuarantine({
          env,
          kind: "agent",
          path: databasePath,
          reason: "committed reason",
        }),
      ).toBe(true);

      const crashed = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.OPENCLAW_QUARANTINE_TEST_PATH);
            database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
            database.prepare("UPDATE quarantined_databases SET reason = 'uncommitted reason'").run();
            process.kill(process.pid, "SIGKILL");
          `,
        ],
        { env: { ...process.env, OPENCLAW_QUARANTINE_TEST_PATH: storePath } },
      );
      expect(crashed.signal).toBe("SIGKILL");
      expect(fs.existsSync(`${storePath}-journal`)).toBe(true);

      expect(readOpenClawDatabaseQuarantine(databasePath, { env })?.reason).toBe(
        "committed reason",
      );
    },
  );

  it("does not latch transient verifier errors", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-transient-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];

    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "Error: database is busy", terminal: false }],
      targets,
    });

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("persists state failure quarantine across restart until doctor repair", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-state-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    expect(
      recordOpenClawDatabaseQuarantine({
        env,
        kind: "state",
        path: statePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordOpenClawStateDatabaseOpenFailure(statePath, error);

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(quarantineStorePath(stateDir), { readOnly: true });
    try {
      expect(
        raw.prepare("SELECT kind, reason FROM quarantined_databases WHERE path = ?").get(statePath),
      ).toEqual({ kind: "state", reason: "corrupt index" });
    } finally {
      raw.close();
    }
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });
});
