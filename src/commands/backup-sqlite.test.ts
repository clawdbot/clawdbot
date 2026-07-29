import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.generated.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.generated.js";
import {
  backupSqliteCreateCommand,
  backupSqliteListCommand,
  backupSqliteRestoreCommand,
  backupSqliteVerifyCommand,
} from "./backup-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function createGlobalDatabase(databasePath: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      ${OPENCLAW_STATE_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      CREATE TABLE durable_entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
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
          ) VALUES ('primary', 'global', ?, NULL, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    database
      .prepare(
        `
          INSERT INTO delivery_queue_entries (
            queue_name,
            id,
            status,
            entry_json,
            enqueued_at,
            updated_at
          ) VALUES ('delivery', 'queued', 'pending', ?, 1, 1)
        `,
      )
      .run('{"payload":"do-not-restore"}');
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("checkpointed");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("committed-in-wal");
  } finally {
    database.close();
  }
}

function createAgentDatabase(databasePath: string, agentId: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec(`
      ${OPENCLAW_AGENT_SCHEMA_SQL}
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      CREATE TABLE durable_entries (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
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
          ) VALUES ('primary', 'agent', ?, ?, NULL, 1, 1)
        `,
      )
      .run(OPENCLAW_AGENT_SCHEMA_VERSION, agentId);
    database.prepare("INSERT INTO durable_entries (value) VALUES (?)").run("agent-state");
  } finally {
    database.close();
  }
}

describe("SQLite backup commands", () => {
  it("creates, lists, verifies, and fresh-restores the global database", async () => {
    const tempDir = tempDirs.make("openclaw-backup-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const repositoryPath = path.join(tempDir, "snapshots");
    const scratchPath = path.join(tempDir, "scratch");
    const restorePath = path.join(tempDir, "restore", "openclaw.sqlite");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawStateSqlitePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.mkdir(scratchPath, { mode: 0o700 });
    await fs.chmod(scratchPath, 0o700);
    createGlobalDatabase(databasePath);
    const runtime = createRuntimeCapture();

    const created = await backupSqliteCreateCommand(runtime, {
      global: true,
      repository: repositoryPath,
      json: true,
    });
    expect(created.manifest.database).toMatchObject({
      role: "global",
      basename: "openclaw.sqlite",
      userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(JSON.parse(runtime.logs.shift() ?? "{}")).toEqual(created);

    const listed = await backupSqliteListCommand(runtime, {
      repository: repositoryPath,
      json: true,
    });
    expect(listed.snapshots).toHaveLength(1);
    expect(listed.snapshots[0]?.manifest.snapshotId).toBe(created.manifest.snapshotId);

    const verified = await backupSqliteVerifyCommand(runtime, created.snapshotPath, {
      scratch: scratchPath,
      json: true,
    });
    expect(verified.manifest).toEqual(created.manifest);
    await expect(fs.readdir(scratchPath)).resolves.toEqual([]);

    const restored = await backupSqliteRestoreCommand(runtime, created.snapshotPath, {
      target: restorePath,
      json: true,
    });
    expect(restored).toMatchObject({
      ok: true,
      snapshotPath: created.snapshotPath,
      targetPath: restorePath,
    });
    expect(runtime.errors).toEqual([]);

    const sqlite = requireNodeSqlite();
    const restoredDatabase = new sqlite.DatabaseSync(restorePath, { readOnly: true });
    try {
      expect(
        restoredDatabase.prepare("SELECT value FROM durable_entries ORDER BY id").all(),
      ).toEqual([{ value: "checkpointed" }, { value: "committed-in-wal" }]);
      expect(
        restoredDatabase.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      ).toEqual({ count: 0 });
    } finally {
      restoredDatabase.close();
    }
  });

  it("creates a snapshot for a normalized per-agent database", async () => {
    const tempDir = tempDirs.make("openclaw-backup-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const repositoryPath = path.join(tempDir, "snapshots");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "ops-team" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    createAgentDatabase(databasePath, "ops-team");
    const runtime = createRuntimeCapture();

    const created = await backupSqliteCreateCommand(runtime, {
      agent: "Ops Team",
      repository: repositoryPath,
    });

    expect(created.manifest.database).toEqual({
      role: "agent",
      agentId: "ops-team",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(runtime.logs).toEqual([expect.stringContaining("Database: agent:ops-team")]);
    expect(runtime.errors).toEqual([]);
  });

  it("requires exactly one named OpenClaw database source", async () => {
    const runtime = createRuntimeCapture();

    await expect(
      backupSqliteCreateCommand(runtime, { repository: "/tmp/snapshots" }),
    ).rejects.toThrow("Choose a SQLite snapshot source");
    await expect(
      backupSqliteCreateCommand(runtime, {
        global: true,
        agent: "main",
        repository: "/tmp/snapshots",
      }),
    ).rejects.toThrow("Choose exactly one SQLite snapshot source");
  });

  it("requires repository, snapshot, and restore target paths", async () => {
    const runtime = createRuntimeCapture();

    await expect(backupSqliteCreateCommand(runtime, { global: true })).rejects.toThrow(
      "Missing required --repository value",
    );
    await expect(backupSqliteVerifyCommand(runtime, " ", {})).rejects.toThrow(
      "Missing required <snapshot> value",
    );
    await expect(backupSqliteRestoreCommand(runtime, "/tmp/snapshot", {})).rejects.toThrow(
      "Missing required --target value",
    );
  });

  it("rejects generic provider artifacts before verify or restore", async () => {
    const tempDir = tempDirs.make("openclaw-backup-sqlite-");
    const databasePath = path.join(tempDir, "generic.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    const restorePath = path.join(tempDir, "restore", "generic.sqlite");
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY);");
    } finally {
      database.close();
    }
    const snapshot = await createLocalSqliteSnapshotProvider({ repositoryPath }).create({
      path: databasePath,
      identity: { role: "generic", id: "generic-test" },
    });
    const runtime = createRuntimeCapture();

    await expect(backupSqliteListCommand(runtime, { repository: repositoryPath })).rejects.toThrow(
      /database role generic is not allowed/u,
    );
    await expect(backupSqliteVerifyCommand(runtime, snapshot.ref.path, {})).rejects.toThrow(
      /database role generic is not allowed/u,
    );
    await expect(
      backupSqliteRestoreCommand(runtime, snapshot.ref.path, { target: restorePath }),
    ).rejects.toThrow(/database role generic is not allowed/u);
    await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function createRuntimeCapture(): RuntimeEnv & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log(value) {
      logs.push(String(value));
    },
    error(value) {
      errors.push(String(value));
    },
    exit(code) {
      throw new Error(`exit ${code}`);
    },
  };
}
