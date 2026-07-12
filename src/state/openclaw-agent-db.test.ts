// OpenClaw agent database tests cover agent-scoped DB storage and migrations.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
} from "./sqlite-schema-shape.test-support.js";

type AgentDbTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "memory_index_sources" | "schema_meta"
>;

const agentDbTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function readRegisteredAgentDatabaseLastSeenAt(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path: string;
}): number | undefined {
  const row = openOpenClawStateDatabase({ env: params.env })
    .db.prepare("SELECT last_seen_at FROM agent_databases WHERE agent_id = ? AND path = ?")
    .get(params.agentId, params.path) as { last_seen_at?: unknown } | undefined;
  return typeof row?.last_seen_at === "number" ? row.last_seen_at : undefined;
}

function seedVersion1MemoryAgentDatabase(
  databasePath: string,
  options: { malformedPathFts?: boolean } = {},
): void {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'worker-1', NULL, 1, 1);
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state VALUES (1, 7);
      CREATE TABLE memory_index_sources (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (path, source)
      );
      INSERT INTO memory_index_sources (rowid, path, source, hash, mtime, size)
      VALUES
        (41, 'shared.md', 'memory', 'memory-hash', 10, 20),
        (84, 'shared.md', 'sessions', 'session-hash', 30, 40);
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory_index_chunks VALUES (
        'sentinel', 'shared.md', 'memory', 1, 1, 'chunk-hash', 'model', 'body', '[]', 1
      );
      CREATE TRIGGER memory_index_sources_revision_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_update
      AFTER UPDATE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
      CREATE TRIGGER memory_index_sources_revision_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
    `);
    if (options.malformedPathFts) {
      db.exec(`
        CREATE TABLE memory_index_paths_fts (wrong_column TEXT);
        INSERT INTO memory_index_paths_fts VALUES ('keep-derived-row');
        CREATE TRIGGER memory_index_paths_fts_after_delete
        AFTER DELETE ON memory_index_sources BEGIN SELECT 1; END;
      `);
      return;
    }
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(path, source UNINDEXED);
      INSERT INTO memory_index_paths_fts (path, source)
      VALUES ('shared.md', 'memory'), ('shared.md', 'sessions');
      CREATE TRIGGER memory_index_paths_fts_after_insert
      AFTER INSERT ON memory_index_sources
      BEGIN
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_update
      AFTER UPDATE OF path, source ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
        INSERT INTO memory_index_paths_fts (path, source) VALUES (NEW.path, NEW.source);
      END;
      CREATE TRIGGER memory_index_paths_fts_after_delete
      AFTER DELETE ON memory_index_sources
      BEGIN
        DELETE FROM memory_index_paths_fts
        WHERE path = OLD.path AND source = OLD.source;
      END;
    `);
  } finally {
    db.close();
  }
}

type AgentSchemaOpenerResult = { agentId: string; ok: boolean; error?: string };

function launchAgentSchemaOpener(params: {
  agentId: string;
  databasePath: string;
  stateDir: string;
}) {
  const agentModuleUrl = new URL("./openclaw-agent-db.ts", import.meta.url).href;
  const stateModuleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        import {
          ensureOpenClawAgentDatabaseSchema,
        } from ${JSON.stringify(agentModuleUrl)};
        import {
          closeOpenClawStateDatabaseForTest,
        } from ${JSON.stringify(stateModuleUrl)};

        const db = new DatabaseSync(process.env.OPENCLAW_AGENT_DB_RACE_PATH);
        db.exec("PRAGMA busy_timeout = 5000;");
        const observedDb = new Proxy(db, {
          get(target, property) {
            if (property === "exec") {
              return (sql) => {
                if (sql.trimStart().startsWith("BEGIN IMMEDIATE")) {
                  console.log("begin-attempt");
                }
                return target.exec(sql);
              };
            }
            if (property === "prepare") {
              return (sql) => target.prepare(sql);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        console.log("ready");
        process.stdin.once("data", () => {
          let result;
          try {
            ensureOpenClawAgentDatabaseSchema(observedDb, {
              agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT,
              env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_RACE_STATE_DIR },
              path: process.env.OPENCLAW_AGENT_DB_RACE_PATH,
              register: true,
            });
            result = { agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT, ok: true };
          } catch (error) {
            result = {
              agentId: process.env.OPENCLAW_AGENT_DB_RACE_AGENT,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            closeOpenClawStateDatabaseForTest();
            db.close();
          }
          console.log(JSON.stringify(result));
        });
      `,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_AGENT_DB_RACE_AGENT: params.agentId,
        OPENCLAW_AGENT_DB_RACE_PATH: params.databasePath,
        OPENCLAW_AGENT_DB_RACE_STATE_DIR: params.stateDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readyResolved = false;
  let beginResolved = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveBegin: (() => void) | undefined;
  let rejectBegin: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const beginAttempt = new Promise<void>((resolve, reject) => {
    resolveBegin = resolve;
    rejectBegin = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    if (!readyResolved && lines.includes("ready")) {
      readyResolved = true;
      resolveReady?.();
    }
    if (!beginResolved && lines.includes("begin-attempt")) {
      beginResolved = true;
      resolveBegin?.();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<AgentSchemaOpenerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const earlyExit = new Error(`agent opener exited before synchronization: ${stderr}`);
      if (!readyResolved) {
        rejectReady?.(earlyExit);
      }
      if (!beginResolved) {
        rejectBegin?.(earlyExit);
      }
      if (code !== 0) {
        reject(new Error(`agent opener exited ${String(code)}: ${stderr}`));
        return;
      }
      const resultLine = stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith("{"));
      if (!resultLine) {
        reject(new Error(`agent opener returned no result: ${stdout} ${stderr}`));
        return;
      }
      resolve(JSON.parse(resultLine) as AgentSchemaOpenerResult);
    });
  });
  return { beginAttempt, child, ready, result };
}

afterAll(() => {
  cleanupTempDirs(agentDbTempDirs);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw agent database", () => {
  it("resolves under the per-agent state directory", () => {
    const stateDir = createTempStateDir();

    expect(
      resolveOpenClawAgentSqlitePath({
        agentId: "Worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toBe(path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite"));
  });

  it("keeps test default state under a worker-sharded temp directory", () => {
    expect(
      resolveOpenClawAgentSqlitePath({
        agentId: "main",
        env: {
          VITEST: "true",
          VITEST_WORKER_ID: "7",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(
      path.join(
        os.tmpdir(),
        "openclaw-test-state",
        `${process.pid}-7`,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      ),
    );
  });

  it("lists a missing registry without creating the shared state database", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");

    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(fs.existsSync(stateDatabasePath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the missing registry has a dangling parent symlink",
    () => {
      const stateDir = createTempStateDir();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      fs.symlinkSync(path.join(stateDir, "missing-state"), path.join(stateDir, "state"), "dir");

      expect(() => listOpenClawRegisteredAgentDatabases({ env })).toThrow("is unavailable");
    },
  );

  it("lists the registry without updating shared schema metadata", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const stateDatabase = openOpenClawStateDatabase({ env });
    stateDatabase.db
      .prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = ?")
      .run(1, "primary");

    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      stateDatabase.db
        .prepare("SELECT updated_at FROM schema_meta WHERE meta_key = ?")
        .get("primary"),
    ).toEqual({ updated_at: 1 });
  });

  it("creates the per-agent schema and registers it globally", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(collectSqliteSchemaShape(database.db)).toEqual(
      createSqliteSchemaShapeFromSql(new URL("./openclaw-agent-schema.sql", import.meta.url)),
    );
    expect(database.agentId).toBe("worker-1");
    expect(database.path).toBe(
      path.join(stateDir, "agents", "worker-1", "agent", "openclaw-agent.sqlite"),
    );

    const registered = listOpenClawRegisteredAgentDatabases({
      env: { OPENCLAW_STATE_DIR: stateDir },
    }).find((entry) => entry.agentId === "worker-1");

    expect(registered).toMatchObject({
      agentId: "worker-1",
      path: database.path,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(registered?.sizeBytes).toBeGreaterThan(0);
  });

  it("generates stable typed memory source identities", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const agentDb = getNodeSqliteKysely<AgentDbTestDatabase>(database.db);

    const inserted = executeSqliteQuerySync(
      database.db,
      agentDb.insertInto("memory_index_sources").values({
        path: "MEMORY.md",
        source: "memory",
        hash: "hash",
        mtime: 1,
        size: 2,
      }),
    );

    expect(inserted.insertId).toBe(1n);
    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        agentDb
          .selectFrom("memory_index_sources")
          .select(["id", "path", "source"])
          .where("path", "=", "MEMORY.md"),
      ),
    ).toEqual({ id: 1, path: "MEMORY.md", source: "memory" });
  });

  it("migrates version 1 memory source identities before registering version 2", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    seedVersion1MemoryAgentDatabase(databasePath);

    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });

    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      database.db.prepare("SELECT id, path, source FROM memory_index_sources ORDER BY id").all(),
    ).toEqual([
      { id: 41, path: "shared.md", source: "memory" },
      { id: 84, path: "shared.md", source: "sessions" },
    ]);
    expect(
      database.db
        .prepare("SELECT rowid, path, source FROM memory_index_paths_fts ORDER BY rowid")
        .all(),
    ).toEqual([
      { rowid: 41, path: "shared.md", source: "memory" },
      { rowid: 84, path: "shared.md", source: "sessions" },
    ]);
    expect(database.db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
      { id: "sentinel", text: "body" },
    ]);
    expect(database.db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({
      revision: 7,
    });
    expect(
      database.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });

    database.db
      .prepare("UPDATE memory_index_sources SET path = ? WHERE id = ?")
      .run("renamed.md", 41);
    expect(
      database.db.prepare("SELECT rowid, path FROM memory_index_paths_fts ORDER BY rowid").all(),
    ).toEqual([
      { rowid: 41, path: "renamed.md" },
      { rowid: 84, path: "shared.md" },
    ]);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).find((entry) => entry.agentId === "worker-1"),
    ).toMatchObject({ path: databasePath, schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION });

    closeOpenClawAgentDatabasesForTest();
    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db.prepare("SELECT id, path FROM memory_index_sources ORDER BY id").all(),
    ).toEqual([
      { id: 41, path: "renamed.md" },
      { id: 84, path: "shared.md" },
    ]);
  });

  it("rolls back a failed version 1 migration without claiming version 2", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    seedVersion1MemoryAgentDatabase(databasePath, { malformedPathFts: true });

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow();

    const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    expect(fs.existsSync(stateDatabasePath)).toBe(false);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    try {
      expect(readSqliteNumberPragma(db, "user_version")).toBe(1);
      expect(
        db
          .prepare("SELECT schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: 1, agent_id: "worker-1" });
      expect(
        db.prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY rowid").all(),
      ).toEqual([
        { path: "shared.md", source: "memory", hash: "memory-hash" },
        { path: "shared.md", source: "sessions", hash: "session-hash" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "sentinel", text: "body" },
      ]);
      expect(db.prepare("SELECT wrong_column FROM memory_index_paths_fts").all()).toEqual([
        { wrong_column: "keep-derived-row" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_index_sources_revision_after_%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "memory_index_sources_revision_after_delete" },
        { name: "memory_index_sources_revision_after_insert" },
        { name: "memory_index_sources_revision_after_update" },
      ]);
    } finally {
      db.close();
    }
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
  });

  it.runIf(process.platform === "linux")("closes the database when initialization fails", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "agent.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
        path: databasePath,
      }),
    ).toThrow("file is not a database");
    expect(listOpenFileDescriptorsForPath(databasePath)).toEqual([]);
  });

  it("keeps multiple registered paths for the same agent", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const relocatedPath = path.join(stateDir, "relocated", "worker-1.sqlite");
    const relocated = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: relocatedPath,
    });
    const defaultDatabase = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
    });

    expect(
      listOpenClawRegisteredAgentDatabases({ env })
        .filter((entry) => entry.agentId === "worker-1")
        .map((entry) => entry.path),
    ).toEqual([defaultDatabase.path, relocated.path].toSorted());
  });

  it("does not refresh global registry metadata on cached opens", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      const first = openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
      });
      expect(
        readRegisteredAgentDatabaseLastSeenAt({
          agentId: "worker-1",
          env,
          path: first.path,
        }),
      ).toBe(1_000);

      nowSpy.mockReturnValue(2_000);
      const second = openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
      });

      expect(second).toBe(first);
      expect(
        readRegisteredAgentDatabaseLastSeenAt({
          agentId: "worker-1",
          env,
          path: first.path,
        }),
      ).toBe(1_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects the legacy agent registry primary key with a doctor repair hint", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const stateDatabasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const legacyDb = new DatabaseSync(stateDatabasePath);
    legacyDb.exec(`
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
      INSERT INTO agent_databases (
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      ) VALUES (
        'worker-1',
        '/legacy/worker-1/openclaw-agent.sqlite',
        1,
        10,
        20
      );
    `);
    legacyDb.close();

    expect(() => listOpenClawRegisteredAgentDatabases({ env })).toThrow(
      /run openclaw doctor --fix/,
    );

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
      }),
    ).toThrow(/run openclaw doctor --fix/);
  });

  it("keys explicit relative paths by resolved database pathname", () => {
    const agentModuleUrl = new URL("./openclaw-agent-db.ts", import.meta.url).href;
    const stateModuleUrl = new URL("./openclaw-state-db.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import os from "node:os";
          import path from "node:path";
          import {
            closeOpenClawAgentDatabasesForTest,
            listOpenClawRegisteredAgentDatabases,
            openOpenClawAgentDatabase,
          } from ${JSON.stringify(agentModuleUrl)};
          import {
            closeOpenClawStateDatabaseForTest,
          } from ${JSON.stringify(stateModuleUrl)};

          const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-state-"));
          const env = { OPENCLAW_STATE_DIR: stateDir };
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-db-relative-"));
          const firstDir = path.join(root, "first");
          const secondDir = path.join(root, "second");
          fs.mkdirSync(firstDir);
          fs.mkdirSync(secondDir);
          const previousCwd = process.cwd();
          try {
            process.chdir(firstDir);
            const first = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            process.chdir(secondDir);
            const second = openOpenClawAgentDatabase({
              agentId: "worker-1",
              env,
              path: "agent.sqlite",
            });

            console.log(JSON.stringify({
              sameHandle: first === second,
              firstFileExists: fs.existsSync(path.join(firstDir, "agent.sqlite")),
              secondFileExists: fs.existsSync(path.join(secondDir, "agent.sqlite")),
              registeredPaths: listOpenClawRegisteredAgentDatabases({ env })
                .filter((entry) => entry.agentId === "worker-1")
                .map((entry) => entry.path),
              expectedPaths: [first.path, second.path].toSorted(),
            }));
          } finally {
            process.chdir(previousCwd);
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
          }
        `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output) as {
      expectedPaths: string[];
      firstFileExists: boolean;
      registeredPaths: string[];
      sameHandle: boolean;
      secondFileExists: boolean;
    };

    expect(result.sameHandle).toBe(false);
    expect(result.firstFileExists).toBe(true);
    expect(result.secondFileExists).toBe(true);
    expect(result.registeredPaths).toEqual(result.expectedPaths);
  });

  it("rejects sharing one explicit database path across agent ids", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "relocated", "shared.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/already open for agent worker-1/);

    closeOpenClawAgentDatabasesForTest();
    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-2",
        env,
        path: databasePath,
      }),
    ).toThrow(/belongs to agent worker-1/);
  });

  it("closes only the cached database at the exact resolved path", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const firstPath = path.join(stateDir, "relocated", "first.sqlite");
    const secondPath = path.join(stateDir, "relocated", "second.sqlite");
    const first = openOpenClawAgentDatabase({ agentId: "worker-1", env, path: firstPath });
    const second = openOpenClawAgentDatabase({ agentId: "worker-2", env, path: secondPath });

    expect(closeOpenClawAgentDatabaseByPath(path.join(stateDir, "missing.sqlite"))).toBe(false);
    expect(first.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);

    expect(
      closeOpenClawAgentDatabaseByPath(
        path.join(stateDir, "relocated", "nested", "..", "first.sqlite"),
      ),
    ).toBe(true);
    expect(first.db.isOpen).toBe(false);
    expect(second.db.isOpen).toBe(true);
    expect(closeOpenClawAgentDatabaseByPath(firstPath)).toBe(false);

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env, path: firstPath });
    expect(reopened).not.toBe(first);
    expect(reopened.db.isOpen).toBe(true);
    expect(second.db.isOpen).toBe(true);
  });

  it("disposes only its exact cached owner and unregisters that registry row", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const first = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const second = openOpenClawAgentDatabase({ agentId: "worker-2", env });

    expect(disposeOpenClawAgentDatabaseByPath(first.path, { env })).toBe(true);
    expect(first.db.isOpen).toBe(false);
    expect(second.db.isOpen).toBe(true);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "worker-2", path: second.path }),
    ]);
    expect(disposeOpenClawAgentDatabaseByPath(first.path, { env })).toBe(false);
    expect(second.db.isOpen).toBe(true);
  });

  it("serializes concurrent ownership claims for one unowned database", async () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "relocated", "shared.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const lockDb = new DatabaseSync(databasePath);
    lockDb.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    const openers = [
      launchAgentSchemaOpener({ agentId: "worker-a", databasePath, stateDir }),
      launchAgentSchemaOpener({ agentId: "worker-b", databasePath, stateDir }),
    ];
    try {
      await Promise.all(openers.map((opener) => opener.ready));
      for (const opener of openers) {
        opener.child.stdin.end("go\n");
      }
      await Promise.all(openers.map((opener) => opener.beginAttempt));
      lockDb.exec("COMMIT;");
      lockDb.close();

      const results = await Promise.all(openers.map((opener) => opener.result));
      const winner = results.find((result) => result.ok);
      const loser = results.find((result) => !result.ok);
      expect(winner).toBeDefined();
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(loser?.error).toContain(`belongs to agent ${winner?.agentId}`);
      expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
        status: "owned",
        agentId: winner?.agentId,
      });
      expect(
        listOpenClawRegisteredAgentDatabases({ env: { OPENCLAW_STATE_DIR: stateDir } }),
      ).toEqual([
        expect.objectContaining({
          agentId: winner?.agentId,
          path: databasePath,
          schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        }),
      ]);
    } finally {
      if (lockDb.isOpen) {
        try {
          lockDb.exec("ROLLBACK;");
        } catch {}
        lockDb.close();
      }
      for (const opener of openers) {
        if (opener.child.exitCode === null) {
          opener.child.kill();
        }
      }
    }
  });

  it("rechecks schema version after waiting for a concurrent writer", async () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(stateDir, "relocated", "future.sqlite");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const lockDb = new DatabaseSync(databasePath);
    lockDb.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = 1; BEGIN IMMEDIATE;");
    const opener = launchAgentSchemaOpener({
      agentId: "worker-a",
      databasePath,
      stateDir,
    });
    const futureVersion = OPENCLAW_AGENT_SCHEMA_VERSION + 1;
    try {
      await opener.ready;
      opener.child.stdin.end("go\n");
      await opener.beginAttempt;
      lockDb.exec(`PRAGMA user_version = ${futureVersion}; COMMIT;`);
      lockDb.close();

      await expect(opener.result).resolves.toMatchObject({
        agentId: "worker-a",
        ok: false,
        error: expect.stringContaining(`newer schema version ${futureVersion}`),
      });
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readSqliteNumberPragma(db, "user_version")).toBe(futureVersion);
        expect(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
            .get(),
        ).toBeUndefined();
      } finally {
        db.close();
      }
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      expect(
        listOpenClawRegisteredAgentDatabases({ env: { OPENCLAW_STATE_DIR: stateDir } }),
      ).toEqual([]);
    } finally {
      if (lockDb.isOpen) {
        try {
          lockDb.exec("ROLLBACK;");
        } catch {}
        lockDb.close();
      }
      if (opener.child.exitCode === null) {
        opener.child.kill();
      }
    }
  });

  it("rejects explicit paths that point at the global state database", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const stateDatabase = openOpenClawStateDatabase({
      env,
      path: databasePath,
    });
    closeOpenClawStateDatabaseForTest();

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env,
        path: stateDatabase.path,
      }),
    ).toThrow(/schema role global/);

    const reopenedStateDatabase = openOpenClawStateDatabase({
      env,
      path: databasePath,
    });
    const row = reopenedStateDatabase.db
      .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
      .get() as { agent_id?: unknown; role?: unknown } | undefined;
    expect(row).toEqual({ role: "global", agent_id: null });
  });

  it("does not chmod shared parent directories for explicit database paths", () => {
    const parentDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: parentDir };
    fs.chmodSync(parentDir, 0o755);
    const databasePath = path.join(parentDir, "worker-1.sqlite");

    openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: databasePath,
    });

    expect(fs.statSync(parentDir).mode & 0o777).toBe(0o755);
  });

  it.runIf(process.platform !== "win32")(
    "defers nested permission repair until the outer transaction commits",
    () => {
      const stateDir = createTempStateDir();
      const options = {
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      };
      const database = openOpenClawAgentDatabase(options);
      fs.chmodSync(database.path, 0o644);

      runOpenClawAgentWriteTransaction(() => {
        runOpenClawAgentWriteTransaction(() => undefined, options);
        expect(fs.statSync(database.path).mode & 0o777).toBe(0o644);
      }, options);

      expect(fs.statSync(database.path).mode & 0o777).toBe(0o600);
    },
  );

  it("configures durable SQLite connection pragmas", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteNumberPragma(database.db, "busy_timeout")).toBe(
      OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
    );
    expect(readSqliteNumberPragma(database.db, "foreign_keys")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "synchronous")).toBe(1);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(readSqliteNumberPragma(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("records durable per-agent schema metadata", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const agentDb = getNodeSqliteKysely<AgentDbTestDatabase>(database.db);

    expect(
      executeSqliteQueryTakeFirstSync(
        database.db,
        agentDb.selectFrom("schema_meta").select(["role", "schema_version", "agent_id"]),
      ),
    ).toEqual({
      role: "agent",
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      agent_id: "worker-1",
    });
  });

  it("inspects registered database ownership without mutating the database", () => {
    const stateDir = createTempStateDir();
    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const databasePath = database.path;
    closeOpenClawAgentDatabasesForTest();

    expect(inspectOpenClawAgentDatabaseOwner(databasePath)).toEqual({
      status: "owned",
      agentId: "worker-1",
    });
  });

  it("migrates compact v1 session tables before applying normalized indexes", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE schema_meta (
        meta_key TEXT NOT NULL PRIMARY KEY,
        role TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        agent_id TEXT,
        app_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 1, 'worker-1', NULL, 1, 1);
      CREATE TABLE sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES ('session-1', 'agent:worker-1:main', 10, 20);
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
      VALUES (
        'agent:worker-1:group:example',
        'session-1',
        '{"sessionId":"session-1","updatedAt":20,"startedAt":11,"endedAt":19,"status":"done","chatType":"group","channel":"discord","deliveryContext":{"accountId":"acct-1"},"modelProvider":"openai","model":"gpt-5.5","agentHarnessId":"codex","parentSessionKey":"agent:worker-1:parent","spawnedBy":"agent:worker-1:spawner","displayName":"Example group"}',
        20
      );
      CREATE TABLE memory_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL
      );
      INSERT INTO memory_index_state (id, revision) VALUES (1, 1);
      CREATE TABLE memory_index_sources (
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT,
        session_id TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL DEFAULT 'memory',
        source_key TEXT NOT NULL,
        path TEXT NOT NULL,
        session_id TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        embedding_dims INTEGER,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_kind, source_key)
          REFERENCES memory_index_sources(source_kind, source_key) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `);
    db.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(4);
    const session = database.db
      .prepare(
        `
          SELECT
            account_id,
            agent_harness_id,
            channel,
            chat_type,
            display_name,
            ended_at,
            model,
            model_provider,
            parent_session_key,
            session_scope,
            spawned_by,
            started_at,
            status
          FROM sessions
          WHERE session_id = ?
        `,
      )
      .get("session-1");
    expect(session).toEqual({
      account_id: "acct-1",
      agent_harness_id: "codex",
      channel: "discord",
      chat_type: "group",
      display_name: "Example group",
      ended_at: 19,
      model: "gpt-5.5",
      model_provider: "openai",
      parent_session_key: "agent:worker-1:parent",
      session_scope: "group",
      spawned_by: "agent:worker-1:spawner",
      started_at: 11,
      status: "done",
    });
    const route = database.db
      .prepare("SELECT session_id, updated_at FROM session_routes WHERE session_key = ?")
      .get("agent:worker-1:group:example");
    expect(route).toEqual({
      session_id: "session-1",
      updated_at: 20,
    });
    const sessionForeignKeys = database.db.prepare("PRAGMA foreign_key_list(sessions)").all() as
      | Array<{ from?: unknown; on_delete?: unknown; table?: unknown; to?: unknown }>
      | undefined;
    expect(sessionForeignKeys).toContainEqual(
      expect.objectContaining({
        from: "primary_conversation_id",
        on_delete: "SET NULL",
        table: "conversations",
        to: "conversation_id",
      }),
    );
    const memoryIndexSourceColumns = database.db
      .prepare("PRAGMA table_info(memory_index_sources)")
      .all() as Array<{ name?: unknown }>;
    // Canonical memory-source identity keeps stable integer ids so FTS rowids
    // survive VACUUM (main's v2 shape, folded into the flip schema).
    expect(memoryIndexSourceColumns.map((column) => column.name)).toEqual([
      "id",
      "path",
      "source",
      "hash",
      "mtime",
      "size",
    ]);
  });
  it("refuses to open newer per-agent schema versions", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    db.close();

    expect(() =>
      openOpenClawAgentDatabase({
        agentId: "worker-1",
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toThrow(
      `OpenClaw agent database ${databasePath} uses newer schema version ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}; this OpenClaw build supports ${OPENCLAW_AGENT_SCHEMA_VERSION}. Upgrade OpenClaw before opening this database. Do not downgrade OpenClaw or modify the database. To run this older build, use a separate state directory or restore a compatible backup.`,
    );
  });

  it("closes cached handles on normal process exit so no stale WAL remains", () => {
    const stateDir = createTempStateDir();
    const agentModuleUrl = new URL("./openclaw-agent-db.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import { openOpenClawAgentDatabase } from ${JSON.stringify(agentModuleUrl)};

          const database = openOpenClawAgentDatabase({
            agentId: "worker-1",
            env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_AGENT_DB_EXIT_TEST_DIR },
          });
          const walPath = database.path + "-wal";
          console.log(JSON.stringify({
            agentDatabasePath: database.path,
            agentWalBytesBeforeExit: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
          }));
        `,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_AGENT_DB_EXIT_TEST_DIR: stateDir },
      },
    );
    const result = JSON.parse(output) as {
      agentDatabasePath: string;
      agentWalBytesBeforeExit: number;
    };
    if (result.agentWalBytesBeforeExit === 0) {
      // Rollback-journal filesystems (NFS/SMB tmp dirs) never produce a WAL.
      return;
    }
    // The child never closes explicitly; only the exit hook can retire the WAL.
    const walPath = `${result.agentDatabasePath}-wal`;
    const walBytesAfterExit = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    expect(walBytesAfterExit).toBe(0);
  });
});
