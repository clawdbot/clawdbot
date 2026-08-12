import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createPathResolutionEnv } from "../test-utils/env.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackup, initializeGitBackupRepository } from "./git-backup.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFormatFixture(databasePath: string): Promise<void> {
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  try {
    await loadSqliteVecExtension({ db: database });
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL,
        huge INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        optional TEXT
      );
      CREATE VIRTUAL TABLE content_fts USING fts5(body, content='content', content_rowid='id');
      CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
        INSERT INTO content_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2]);
      CREATE TABLE empty_table (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE session_transcript_index_state (id TEXT PRIMARY KEY, cursor INTEGER);
      CREATE TABLE device_auth_tokens (
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        token TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (device_id, role)
      );
    `);
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(1, "hello lobster", 9_007_199_254_740_993n, Buffer.from([0, 1, 254, 255]), "");
    database
      .prepare("INSERT INTO content (id, body, huge, bytes, optional) VALUES (?, ?, ?, ?, ?)")
      .run(2, "second row", -9_007_199_254_740_994n, Buffer.from([42]), null);
    database.prepare("INSERT INTO session_transcript_index_state VALUES (?, ?)").run("main", 99);
    database
      .prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)")
      .run("device", "operator", "secret-token", "[]", 1);
  } finally {
    database.close();
  }
}

async function listTree(root: string): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        result.push([relative, (await fs.readFile(entryPath)).toString("hex")]);
      }
    }
  }
  await visit(root);
  return result;
}

function createStateDatabaseFixture(root: string): {
  stateDir: string;
  database: { path: string; identity: { role: "global" } };
} {
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return {
    stateDir,
    database: {
      path: resolveOpenClawStateSqlitePath(env),
      identity: { role: "global" },
    },
  };
}

describe("Git-backed SQLite snapshots", () => {
  it("dumps byte-identical trees and skips a second unchanged create commit", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    await createFormatFixture(source);

    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: first,
      identity: { role: "global" },
    });
    await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: second,
      identity: { role: "global" },
    });
    expect(await listTree(second)).toEqual(await listTree(first));

    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await initializeGitBackupRepository({ repositoryPath, stateDir });
    await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
    await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
    const created = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    const unchanged = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
    expect(created.noChanges).toBe(false);
    expect(unchanged.noChanges).toBe(true);
    expect(unchanged).not.toHaveProperty("commit");
    expect(await requireGit(repositoryPath, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("uses a commit-scoped fallback identity when Git has no configured email", async () => {
    const root = await tempRoot();
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "identity-free-repository");
    const isolatedHome = path.join(root, "git-home");
    await fs.mkdir(isolatedHome, { recursive: true });
    const gitEnv = createPathResolutionEnv(isolatedHome, {
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });

    const result = await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [database],
      gitEnv,
    });

    expect(result.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(
      await requireGit(repositoryPath, ["log", "-1", "--format=%an <%ae>"], { env: gitEnv }),
    ).toBe("OpenClaw <backup@openclaw.local>");
    expect(
      await requireGit(repositoryPath, ["config", "--local", "--get", "user.email"], {
        env: gitEnv,
      }).catch(() => undefined),
    ).toBeUndefined();
  });

  it("round-trips losslessly, converges FTS, and omits derived vec and transcript state", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    const restoredPath = path.join(root, "restored.sqlite");
    await createFormatFixture(source);
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "global" },
    });
    const restored = await restoreGitBackupDirectory({
      sourcePath: dump,
      targetPath: restoredPath,
      expectedIdentity: { role: "global" },
    });
    expect(restored.tables.every((table) => table.ok)).toBe(true);
    expect(restored.manifest.tables).toEqual(manifest.tables);
    expect(manifest.tables).not.toHaveProperty("session_transcript_index_state");

    const database = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      const statement = database.prepare(
        "SELECT id, huge, bytes, optional FROM content ORDER BY id",
      );
      statement.setReadBigInts(true);
      const rows = statement.all() as Array<{
        id: bigint;
        huge: bigint;
        bytes: Uint8Array;
        optional: string | null;
      }>;
      expect(
        rows.map((row) => ({
          id: row.id,
          huge: row.huge,
          bytes: [...row.bytes],
          optional: row.optional,
        })),
      ).toEqual([
        {
          id: 1n,
          huge: 9_007_199_254_740_993n,
          bytes: [0, 1, 254, 255],
          optional: "",
        },
        { id: 2n, huge: -9_007_199_254_740_994n, bytes: [42], optional: null },
      ]);
      expect(
        database.prepare("SELECT rowid FROM content_fts WHERE content_fts MATCH 'lobster'").all(),
      ).toEqual([{ rowid: 1 }]);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.some((table) => table.name === "memory_vec")).toBe(false);
      expect(tables.some((table) => table.name === "session_transcript_index_state")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("omits secret tables and reports the restore gap", async () => {
    const root = await tempRoot();
    const source = path.join(root, "source.sqlite");
    const dump = path.join(root, "dump");
    await createFormatFixture(source);
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: source,
      outputPath: dump,
      identity: { role: "global" },
      excludeSecrets: true,
    });
    expect(manifest.excludedTables).toContain("device_auth_tokens");
    expect(manifest.tables).not.toHaveProperty("device_auth_tokens");
    const schema = await fs.readFile(path.join(dump, "schema.sql"), "utf8");
    expect(schema).not.toContain("device_auth_tokens");
    const restored = await restoreGitBackupDirectory({
      sourcePath: dump,
      targetPath: path.join(root, "redacted.sqlite"),
    });
    expect(restored.excludedTables).toContain("device_auth_tokens");
  });
});
