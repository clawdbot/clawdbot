// OpenClaw agent database tests cover agent-scoped DB storage and migrations.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  beginAgentDeletion,
  claimCompletedAgentDeletion,
} from "../agents/agent-lifecycle-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { VERSION } from "../version.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeases,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  disposeOpenClawAgentDatabaseByPath,
  ensureOpenClawAgentDatabaseSchema,
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
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  collectSqliteSchemaShape,
  createSqliteSchemaShapeFromSql,
  normalizeSqliteSchemaShapeSql,
  replaceNamedUniqueIndexesWithOrdinaryIndexes,
} from "./sqlite-schema-shape.test-support.js";

type AgentDbTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "memory_index_sources" | "schema_meta"
>;

const agentDbTempDirs: string[] = [];

function createTempStateDir(): string {
  return makeTempDir(agentDbTempDirs, "openclaw-agent-db-");
}

function downgradeCurrentAgentDatabaseToV13(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = OFF;
      DROP INDEX IF EXISTS idx_agent_session_windows_updated_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_created_at;
      DROP INDEX IF EXISTS idx_agent_session_windows_conversation;
      ALTER TABLE session_windows RENAME TO sessions;
      CREATE TABLE sessions_legacy (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_scope TEXT NOT NULL DEFAULT 'conversation' CHECK (session_scope IN ('conversation', 'shared-main', 'group', 'channel')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        transcript_updated_at INTEGER DEFAULT NULL,
        transcript_observed_at INTEGER DEFAULT NULL,
        session_entry_provenance INTEGER NOT NULL DEFAULT 0 CHECK (session_entry_provenance IN (0, 1)),
        acp_owned INTEGER NOT NULL DEFAULT 0 CHECK (acp_owned IN (0, 1)),
        plugin_owner_id TEXT,
        hook_external_content_source TEXT CHECK (hook_external_content_source IS NULL OR hook_external_content_source IN ('gmail', 'webhook')),
        started_at INTEGER,
        ended_at INTEGER,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        chat_type TEXT CHECK (chat_type IS NULL OR chat_type IN ('direct', 'group', 'channel')),
        channel TEXT,
        account_id TEXT,
        primary_conversation_id TEXT,
        model_provider TEXT,
        model TEXT,
        agent_harness_id TEXT,
        parent_session_key TEXT,
        spawned_by TEXT,
        display_name TEXT,
        FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO sessions_legacy (
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      )
      SELECT
        session_id, session_key, session_scope, created_at, updated_at,
        transcript_updated_at, transcript_observed_at, session_entry_provenance,
        acp_owned, plugin_owner_id, hook_external_content_source, started_at,
        ended_at, status, chat_type, channel, account_id, primary_conversation_id,
        model_provider, model, agent_harness_id, parent_session_key, spawned_by,
        display_name
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_legacy RENAME TO sessions;
      CREATE INDEX idx_agent_sessions_updated_at ON sessions(updated_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_created_at ON sessions(created_at DESC, session_id);
      CREATE INDEX idx_agent_sessions_conversation
        ON sessions(primary_conversation_id, updated_at DESC, session_id)
        WHERE primary_conversation_id IS NOT NULL;
      CREATE TABLE session_routes (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_routes_session_id ON session_routes(session_id);
      CREATE TABLE session_entries (
        session_key TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX idx_agent_session_entries_updated_at
        ON session_entries(updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_session_updated
        ON session_entries(session_id, updated_at DESC, session_key);
      CREATE INDEX idx_agent_session_entries_status
        ON session_entries(status, session_key) WHERE status IS NOT NULL;
      CREATE TABLE session_members_v13 (
        session_key TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, identity_id),
        FOREIGN KEY (session_key) REFERENCES session_entries(session_key) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO session_members_v13 SELECT * FROM session_members;
      DROP TABLE session_members;
      ALTER TABLE session_members_v13 RENAME TO session_members;
      CREATE INDEX idx_agent_session_members_identity
        ON session_members(identity_id, session_key);
      ALTER TABLE transcript_rewrite_watermarks RENAME TO session_transcript_generations;
      CREATE TABLE board_tabs_v13 (
        session_key TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        title TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        chat_dock TEXT NOT NULL DEFAULT 'right' CHECK (chat_dock IN ('left', 'right', 'bottom', 'hidden')),
        created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (session_key, tab_id)
      ) STRICT;
      INSERT INTO board_tabs_v13 SELECT * FROM board_tabs;
      DROP TABLE board_tabs;
      ALTER TABLE board_tabs_v13 RENAME TO board_tabs;
      DROP TABLE heartbeat_outcomes;
      CREATE TABLE heartbeat_outcomes (
        session_key TEXT NOT NULL PRIMARY KEY,
        run_session_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('progress', 'done', 'blocked', 'needs_attention')),
        summary TEXT NOT NULL,
        response_reason TEXT,
        priority TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high')),
        next_check TEXT,
        task_names_json TEXT,
        wake_source TEXT,
        wake_reason TEXT,
        occurred_at INTEGER NOT NULL,
        context_run_id TEXT,
        context_claimed_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE session_nodes;
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
  } finally {
    database.close();
  }
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

function createUnsafeSchemaMetaIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE INDEX unsafe_schema_meta_role ON schema_meta(role);");
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_schema_meta_role ON schema_meta(app_version)' WHERE name = 'unsafe_schema_meta_role'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createTranscriptIdempotencyIndexDrift(
  databasePath: string,
  options: { duplicateRows?: boolean } = {},
): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      DROP INDEX idx_agent_transcript_message_idempotency;
      CREATE UNIQUE INDEX idx_agent_transcript_message_idempotency
        ON transcript_event_identities(session_id, event_id);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:worker-1:session-1', 'session-1', '{}', 1);
      INSERT INTO session_windows (
        session_id, session_key, session_scope, created_at, updated_at
      ) VALUES (
        'session-1', 'agent:worker-1:session-1', 'conversation', 1, 1
      );
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES
        ('session-1', 1, '{}', 1),
        ('session-1', 2, '{}', 2);
      INSERT INTO transcript_event_identities (
        session_id, event_id, seq, message_idempotency_key, created_at
      ) VALUES (
        'session-1', 'event-1', 1, 'message-1', 1
      );
    `);
    if (options.duplicateRows) {
      database.exec(`
        INSERT INTO transcript_event_identities (
          session_id, event_id, seq, message_idempotency_key, created_at
        ) VALUES (
          'session-1', 'event-2', 2, 'message-1', 2
        );
      `);
    }
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
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
  it("uses the canonical state schema for deletion journal reads and updates", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const stateDatabase = new DatabaseSync(stateDatabasePath);
    stateDatabase.exec(
      fs.readFileSync(new URL("./openclaw-state-schema.sql", import.meta.url), "utf8"),
    );
    stateDatabase.close();

    const entry = {
      agentId: "deleted",
      agentDir: path.join(stateDir, "agents", "deleted", "agent"),
      workspaceDir: path.join(stateDir, "workspace-deleted"),
      sessionsDir: path.join(stateDir, "sessions-deleted"),
    };
    const deletion = beginAgentDeletion(entry, { env });
    const databasePaths = [path.join(entry.agentDir, "openclaw-agent.sqlite")];
    const cleanupPaths = [
      {
        path: entry.agentDir,
        canonicalPath: entry.agentDir,
        parentPath: path.dirname(entry.agentDir),
        kind: "target" as const,
        sourcePaths: [entry.agentDir],
        dev: null,
        ino: null,
        coversDescendants: true,
        done: false,
      },
    ];
    deletion.fenceDatabasePaths(databasePaths);
    deletion.fenceCleanupPaths(cleanupPaths);

    const recovery = beginAgentDeletion(entry, { env });
    expect(recovery.entry.databasePaths).toEqual(databasePaths);
    expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
    recovery.rollback();
  });

  it("fences registration and lease claims beneath another agent's pending deletion", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "deleted", "agent");
    const linkedAgentDir = path.join(stateDir, "linked-deleted-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(agentDir, linkedAgentDir, "dir");
    const databasePath = path.join(agentDir, "nested", "survivor.sqlite");
    const relocatedDatabasePath = path.join(stateDir, "relocated", "deleted.sqlite");
    const sidecarClaimPath = path.join(stateDir, "sidecar", "shared.sqlite");
    const registeredSidecarPath = `${sidecarClaimPath}-wal`;
    registerOpenClawAgentDatabase({
      agentId: "deleted",
      path: relocatedDatabasePath,
      env,
    });
    registerOpenClawAgentDatabase({ agentId: "deleted", path: registeredSidecarPath, env });
    const deletion = beginAgentDeletion(
      {
        agentId: "deleted",
        agentDir: linkedAgentDir,
        workspaceDir: path.join(stateDir, "workspace-deleted"),
        sessionsDir: path.join(stateDir, "sessions-deleted"),
      },
      { env },
    );

    unregisterOpenClawAgentDatabase({ agentId: "deleted", path: relocatedDatabasePath, env });
    unregisterOpenClawAgentDatabase({ agentId: "deleted", path: registeredSidecarPath, env });

    try {
      for (const fencedPath of [databasePath, relocatedDatabasePath, sidecarClaimPath]) {
        expect(() =>
          registerOpenClawAgentDatabase({ agentId: "survivor", path: fencedPath, env }),
        ).toThrow("deletion owns");
        expect(() =>
          claimOpenClawAgentDatabaseLease({ agentId: "survivor", path: fencedPath, env }),
        ).toThrow("deletion owns");
      }
    } finally {
      deletion.rollback();
    }

    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "survivor", path: databasePath, env }),
    ).not.toThrow();
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "survivor",
      path: databasePath,
      env,
    });
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
    unregisterOpenClawAgentDatabase({ agentId: "survivor", path: databasePath, env });
  });

  it("blocks deletion on a foreign lease beneath its workspace until release", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const workspaceDir = path.join(stateDir, "workspace-deleted");
    const foreignDatabasePath = path.join(workspaceDir, "nested", "survivor.sqlite");
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "survivor",
      path: foreignDatabasePath,
      env,
    });
    const deletion = beginAgentDeletion(
      {
        agentId: "deleted",
        agentDir: path.join(stateDir, "agents", "deleted", "agent"),
        workspaceDir,
        sessionsDir: path.join(stateDir, "sessions-deleted"),
      },
      { env },
    );

    expect(() => assertNoOpenClawAgentDatabaseLeases("deleted", { env })).toThrow("deletion owns");
    releaseOpenClawAgentDatabaseLease(leaseId, { env });
    expect(() => assertNoOpenClawAgentDatabaseLeases("deleted", { env })).not.toThrow();
    deletion.rollback();
  });

  it("rejects a database claim prepared before deletion cleanup completes", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "deleted", "agent");
    const databasePath = path.join(agentDir, "survivor.sqlite");
    const deletion = beginAgentDeletion(
      {
        agentId: "deleted",
        agentDir,
        workspaceDir: path.join(stateDir, "workspace-deleted"),
        sessionsDir: path.join(stateDir, "sessions-deleted"),
      },
      { env },
    );
    const fence = prepareAgentDeletionPathFence(
      { agentId: "survivor", path: databasePath },
      { env },
    );

    deletion.finish();

    expect(() =>
      runOpenClawStateWriteTransaction(
        (database) => assertAgentDeletionPathFence(database.db, fence),
        { env },
      ),
    ).toThrow("deletion journal changed");
  });

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

  it("returns typed not-found without creating a missing read-only database", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const databasePath = resolveOpenClawAgentSqlitePath(options);

    expect(withOpenClawAgentDatabaseReadOnly(() => "unused", options)).toEqual({
      found: false,
      reason: "database-missing",
    });
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("refuses a newer schema from the read-only database helper", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    database.close();

    expect(() => withOpenClawAgentDatabaseReadOnly(() => "unused", options)).toThrow(
      `newer schema version ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
    );
  });

  it("returns typed not-found when a read-only query targets a missing table", () => {
    const stateDir = createTempStateDir();
    const options = {
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    };
    const databasePath = openOpenClawAgentDatabase(options).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE session_nodes;");
    database.close();

    expect(
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT * FROM session_nodes").all(),
        options,
      ),
    ).toEqual({ found: false, reason: "table-missing" });
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
    expect(
      database.db
        .prepare(
          `SELECT name FROM pragma_table_list
           WHERE schema = 'main'
             AND type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND strict <> 1`,
        )
        .all(),
    ).toEqual([]);
    expect(() =>
      database.db
        .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
        .run("not-an-integer"),
    ).toThrow();
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

  it("opens a v13 database that already contains additive board storage", () => {
    expect(OPENCLAW_AGENT_SCHEMA_VERSION).toBe(14);
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const existingV13 = new DatabaseSync(databasePath);
    existingV13.exec(`
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
    existingV13.close();

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db
        .prepare(
          "SELECT name, strict FROM pragma_table_list WHERE name IN ('board_tabs', 'board_widgets') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "board_tabs", strict: 1 },
      { name: "board_widgets", strict: 1 },
    ]);
    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
  });

  it("migrates v13 session entries, routes, and generations into nodes and windows", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES
        ('window-old', 'agent:worker-1:rich', 10, 20),
        ('window-current', 'agent:worker-1:rich', 30, 40),
        ('window-created-by', 'agent:worker-1:created-by', 50, 60),
        ('window-transcript-only', 'agent:worker-1:transcript-only', 70, 80);
      INSERT INTO session_routes (session_key, session_id, updated_at)
      VALUES
        ('agent:worker-1:rich', 'window-current', 40),
        ('agent:worker-1:created-by', 'window-created-by', 60),
        ('agent:worker-1:transcript-only', 'window-transcript-only', 80);
      INSERT INTO session_entries (session_key, session_id, entry_json, updated_at, status)
      VALUES (
        'agent:worker-1:rich',
        'window-current',
        '{"sessionId":"window-current","updatedAt":40,"status":"done","createdAt":11,"createdVia":"spawn","createdActor":{"type":"agent","id":"agent:worker-1:parent"},"spawnedBy":"agent:worker-1:parent","forkSource":{"sessionKey":"agent:worker-1:source","sessionId":"source-window","entryId":"source-entry"},"label":"Rich label","displayName":"Rich display","category":"work","icon":"hammer","pinnedAt":12,"archivedAt":13,"lastReadAt":14,"lastInteractionAt":15,"lastActivityAt":16,"previousSessionId":"window-old"}',
        40,
        'done'
      ), (
        'agent:worker-1:created-by',
        'window-created-by',
        '{"sessionId":"window-created-by","updatedAt":60,"createdBy":{"id":"legacy-human","label":"Legacy"}}',
        60,
        NULL
      ), (
        'agent:worker-1:newer-alias',
        'window-current',
        '{"sessionId":"window-current","updatedAt":100,"previousSessionId":"wrong-window"}',
        100,
        NULL
      );
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES
        ('window-old', 0, '{"type":"session","id":"window-old"}', 10),
        ('window-current', 0, '{"type":"session","id":"window-current"}', 30),
        ('window-transcript-only', 0, '{"type":"session","id":"window-transcript-only"}', 70);
      INSERT INTO session_transcript_generations (session_id, generation, updated_at)
      VALUES ('window-current', 'rewrite-token', 40);
      INSERT INTO session_transcript_index_state (
        session_id, indexed_seq, leaf_event_id, needs_rebuild,
        active_event_count, active_message_count, updated_at
      ) VALUES ('window-current', 0, NULL, 0, 1, 0, 40);
      INSERT INTO heartbeat_outcomes (
        session_key, run_session_key, outcome, summary, occurred_at, updated_at
      ) VALUES (
        'agent:worker-1:rich', 'agent:worker-1:rich', 'done', 'complete', 40, 40
      );
      INSERT INTO session_members (session_key, identity_id, added_by, added_at)
      VALUES ('agent:worker-1:rich', 'member-1', 'owner-1', 40);
      INSERT INTO board_tabs (
        session_key, tab_id, title, position, chat_dock, created_by, revision
      ) VALUES ('agent:worker-1:rich', 'main', 'Main', 0, 'right', 'user', 1);
      INSERT INTO board_widgets (
        session_key, name, tab_id, content_kind, html, sha256, view_generation,
        revision, size_w, size_h, position, created_by, created_at, updated_at
      ) VALUES (
        'agent:worker-1:rich', 'summary', 'main', 'html', X'3C703E6F6B3C2F703E',
        'hash', 'view-1', 1, 4, 4, 0, 'user', 40, 40
      );
      PRAGMA user_version = 13;
      UPDATE schema_meta SET schema_version = 13 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare(
          `SELECT
             current_session_id, created_at, created_via, created_actor_type,
             created_actor_id, parent_session_key, spawned_by,
             fork_source_session_key, fork_source_session_id, fork_source_entry_id,
             label, display_name, category, icon, pinned_at, archived_at,
             last_read_at, last_interaction_at, last_activity_at, status
           FROM session_nodes WHERE session_key = 'agent:worker-1:rich'`,
        )
        .get(),
    ).toEqual({
      current_session_id: "window-current",
      created_at: 11,
      created_via: "spawn",
      created_actor_type: "agent",
      created_actor_id: "agent:worker-1:parent",
      parent_session_key: "agent:worker-1:parent",
      spawned_by: "agent:worker-1:parent",
      fork_source_session_key: "agent:worker-1:source",
      fork_source_session_id: "source-window",
      fork_source_entry_id: "source-entry",
      label: "Rich label",
      display_name: "Rich display",
      category: "work",
      icon: "hammer",
      pinned_at: 12,
      archived_at: 13,
      last_read_at: 14,
      last_interaction_at: 15,
      last_activity_at: 16,
      status: "done",
    });
    expect(
      migrated.db
        .prepare(
          "SELECT created_actor_type, created_actor_id FROM session_nodes WHERE session_key = ?",
        )
        .get("agent:worker-1:created-by"),
    ).toEqual({ created_actor_type: "human", created_actor_id: "legacy-human" });
    expect(
      migrated.db
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get("agent:worker-1:transcript-only"),
    ).toEqual({ entry_json: "{}" });
    expect(
      migrated.db
        .prepare(
          "SELECT session_id, session_key, previous_session_id, reason FROM session_windows ORDER BY session_id",
        )
        .all(),
    ).toEqual([
      {
        session_id: "window-created-by",
        session_key: "agent:worker-1:created-by",
        previous_session_id: null,
        reason: null,
      },
      {
        session_id: "window-current",
        session_key: "agent:worker-1:rich",
        previous_session_id: "window-old",
        reason: null,
      },
      {
        session_id: "window-old",
        session_key: "agent:worker-1:rich",
        previous_session_id: null,
        reason: null,
      },
      {
        session_id: "window-transcript-only",
        session_key: "agent:worker-1:transcript-only",
        previous_session_id: null,
        reason: null,
      },
    ]);
    expect(
      migrated.db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get("window-current"),
    ).toEqual({ generation: "rewrite-token" });
    expect(
      migrated.db
        .prepare("SELECT identity_id, added_by FROM session_members WHERE session_key = ?")
        .get("agent:worker-1:rich"),
    ).toEqual({ identity_id: "member-1", added_by: "owner-1" });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('session_entries', 'session_routes', 'session_transcript_generations')",
        )
        .all(),
    ).toEqual([]);
    expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);

    migrated.db
      .prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run("agent:worker-1:rich");
    for (const table of [
      "session_windows",
      "transcript_events",
      "transcript_rewrite_watermarks",
      "session_transcript_index_state",
      "session_members",
      "heartbeat_outcomes",
      "board_tabs",
      "board_widgets",
    ]) {
      expect(migrated.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
        count: table === "session_windows" ? 2 : table === "transcript_events" ? 1 : 0,
      });
    }
  });

  it("keeps additive heartbeat repair while upgrading schema version 12", () => {
    expect(OPENCLAW_AGENT_SCHEMA_VERSION).toBe(14);
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const existingV12 = new DatabaseSync(databasePath);
    existingV12.exec(`
      DROP TABLE heartbeat_outcomes;
      PRAGMA user_version = 12;
      UPDATE schema_meta SET schema_version = 12 WHERE meta_key = 'primary';
    `);
    existingV12.close();

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("heartbeat_outcomes"),
    ).toEqual({ name: "heartbeat_outcomes" });
    expect(readSqliteNumberPragma(reopened.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      reopened.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
  });

  it("backfills one generation per existing transcript when upgrading v12", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE IF EXISTS session_transcript_generations;
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES
        ('with-transcript', 'agent:worker-1:with-transcript', 10, 20),
        ('without-transcript', 'agent:worker-1:without-transcript', 10, 20);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('with-transcript', 0, '{"type":"session","id":"with-transcript"}', 10);
      PRAGMA user_version = 12;
      UPDATE schema_meta SET schema_version = 12 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const generations = migrated.db
      .prepare(
        "SELECT session_id, generation FROM transcript_rewrite_watermarks ORDER BY session_id",
      )
      .all() as Array<{ generation: string; session_id: string }>;

    expect(generations).toHaveLength(1);
    expect(generations[0]?.session_id).toBe("with-transcript");
    expect(generations[0]?.generation).toMatch(/^[0-9a-f]{32}$/);
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("transcript_rewrite_watermarks"),
    ).toEqual({ strict: 1 });
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
  });

  it("upgrades version 10 with agent state intact and adds lease storage", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    opened.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("last-good", '{"profile":"primary"}', 10);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX idx_agent_state_leases_owner;
      DROP INDEX idx_agent_state_leases_expiry;
      DROP TABLE state_leases;
      PRAGMA user_version = 10;
      UPDATE schema_meta SET schema_version = 10 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    expect(
      migrated.db
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
        .get("last-good"),
    ).toEqual({ state_json: '{"profile":"primary"}' });
    expect(
      migrated.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'state_leases'")
        .get(),
    ).toEqual({ name: "state_leases" });
  });

  it("upgrades version 11 with agent state intact and adds ACP parent-stream storage", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    opened.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("last-good", '{"profile":"primary"}', 10);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX idx_agent_acp_parent_stream_run;
      DROP TABLE acp_parent_stream_events;
      DROP TABLE session_transcript_generations;
      INSERT INTO sessions (session_id, session_key, created_at, updated_at)
      VALUES ('with-transcript', 'agent:worker-1:with-transcript', 10, 20);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('with-transcript', 0, '{"type":"session","id":"with-transcript"}', 10);
      PRAGMA user_version = 11;
      UPDATE schema_meta SET schema_version = 11 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(
      migrated.db
        .prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?")
        .get("last-good"),
    ).toEqual({ state_json: '{"profile":"primary"}' });
    expect(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'acp_parent_stream_events'",
        )
        .get(),
    ).toEqual({ name: "acp_parent_stream_events" });
    expect(
      migrated.db.prepare("SELECT session_id, generation FROM transcript_rewrite_watermarks").get(),
    ).toMatchObject({
      session_id: "with-transcript",
      generation: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  it("migrates version 8 tables to STRICT without losing agent state", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = opened.path;
    opened.db
      .prepare(
        "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("last-good", '{"profile":"primary"}', 10);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE auth_profile_state RENAME TO auth_profile_state_strict;
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_state SELECT * FROM auth_profile_state_strict;
      DROP TABLE auth_profile_state_strict;
      DROP TRIGGER memory_index_sources_revision_after_insert;
      DROP TRIGGER memory_index_sources_revision_after_update;
      DROP TRIGGER memory_index_sources_revision_after_delete;
      ALTER TABLE memory_index_sources RENAME TO memory_index_sources_strict;
      CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      );
      INSERT INTO memory_index_sources SELECT * FROM memory_index_sources_strict;
      DROP TABLE memory_index_sources_strict;
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('MEMORY.md', 'memory', 'legacy-hash', 10.75, 20);
      DROP TABLE session_transcript_active_events;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_event_count;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_message_count;
      PRAGMA user_version = 8;
      UPDATE schema_meta SET schema_version = 8 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = 'auth_profile_state'")
        .get(),
    ).toEqual({ strict: 1 });
    expect(migrated.db.prepare("SELECT * FROM auth_profile_state").get()).toEqual({
      state_key: "last-good",
      state_json: '{"profile":"primary"}',
      updated_at: 10,
    });
    expect(
      migrated.db
        .prepare("SELECT mtime, typeof(mtime) AS storage_type FROM memory_index_sources")
        .get(),
    ).toEqual({ mtime: 10.75, storage_type: "real" });
    expect(
      migrated.db
        .prepare(
          "SELECT strict FROM pragma_table_list WHERE name = 'session_transcript_active_events'",
        )
        .get(),
    ).toEqual({ strict: 1 });
    expect(
      migrated.db
        .prepare("PRAGMA table_info(session_transcript_index_state)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(expect.arrayContaining(["active_event_count", "active_message_count"]));
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      migrated.db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ schema_version: OPENCLAW_AGENT_SCHEMA_VERSION });
    expect(migrated.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
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

  it("rolls back a failed version 1 migration without retaining ownership", () => {
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

    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT COUNT(*) AS count FROM agent_database_leases")
        .get(),
    ).toEqual({ count: 0 });
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

  it("retains a failed-open handle and lease when initialization cleanup also fails", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
      throw new Error("initialization close failed");
    });

    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-2", env, path: database.path }),
    ).toThrow("initialization close failed");
    close.mockRestore();
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-2", { env })).toThrow(
      "database is still open",
    );
    expect(() =>
      openOpenClawAgentDatabase({ agentId: "worker-2", env, path: database.path }),
    ).toThrow("initialization close failed");

    expect(disposeOpenClawAgentDatabaseByPath(database.path, { env })).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-2", { env })).not.toThrow();
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

    fs.rmSync(stateDatabasePath);
    const reopened = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
    });
    expect(reopened.db.isOpen).toBe(true);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({
        agentId: "worker-1",
        path: reopened.path,
      }),
    ]);
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

  it("retains its durable lease when closing the handle fails", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const close = vi.spyOn(database.walMaintenance, "close").mockImplementationOnce(() => {
      throw new Error("wal close failed");
    });

    expect(() => closeOpenClawAgentDatabaseByPath(database.path)).toThrow("wal close failed");
    expect(database.db.isOpen).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
      "database is still open",
    );

    close.mockRestore();
    expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
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

    const reopened = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env,
      path: first.path,
    });
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
      expect.objectContaining({ agentId: "worker-1", path: reopened.path }),
      expect.objectContaining({ agentId: "worker-2", path: second.path }),
    ]);
  });

  it("reopens a recreated agent id on a fresh database after archival", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const original = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const originalInode = fs.statSync(original.path).ino;
    const archivedDir = path.join(stateDir, "trash", "worker-1-agent");
    const deletion = beginAgentDeletion(
      {
        agentId: "worker-1",
        agentDir: path.dirname(original.path),
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    try {
      expect(disposeOpenClawAgentDatabaseByPath(original.path, { env })).toBe(true);
      deletion.commit();
      expect(original.db.isOpen).toBe(false);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
      fs.mkdirSync(path.dirname(archivedDir), { recursive: true });
      fs.renameSync(path.dirname(original.path), archivedDir);
      expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
        "agent worker-1 is deleted",
      );

      deletion.finish();
      expect(claimCompletedAgentDeletion("worker-1", deletion.entry.operationId, { env })).toBe(
        true,
      );
      const recreated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
      expect(recreated.db.isOpen).toBe(true);
      expect(fs.statSync(recreated.path).ino).not.toBe(originalInode);
      expect(fs.existsSync(path.join(archivedDir, "openclaw-agent.sqlite"))).toBe(true);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
        expect.objectContaining({ agentId: "worker-1", path: recreated.path }),
      ]);
    } finally {
      deletion.finish();
    }
  });

  it("keeps the deleted id fenced until its completed tombstone is claimed", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentDir = path.join(stateDir, "agents", "worker-1", "agent");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const deletion = beginAgentDeletion(
      {
        agentId: "worker-1",
        agentDir,
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    deletion.finish();

    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env }),
    ).toThrow("agent worker-1 is deleted");
    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-2", path: databasePath, env }),
    ).not.toThrow();
    unregisterOpenClawAgentDatabase({ agentId: "worker-2", path: databasePath, env });

    expect(claimCompletedAgentDeletion("worker-1", deletion.entry.operationId, { env })).toBe(true);
    expect(() =>
      registerOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env }),
    ).not.toThrow();
    unregisterOpenClawAgentDatabase({ agentId: "worker-1", path: databasePath, env });
  });

  it("serializes database leases with the durable deletion fence", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "worker-1", "openclaw-agent.sqlite");
    const leaseId = claimOpenClawAgentDatabaseLease({
      agentId: "worker-1",
      path: databasePath,
      env,
    });
    const deletion = beginAgentDeletion(
      {
        agentId: "worker-1",
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspace-worker-1"),
        sessionsDir: path.join(stateDir, "sessions-worker-1"),
      },
      { env },
    );
    try {
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).toThrow(
        "database is still open",
      );
      expect(() =>
        claimOpenClawAgentDatabaseLease({ agentId: "worker-1", path: databasePath, env }),
      ).toThrow("agent worker-1 is deleted");
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      expect(() => assertNoOpenClawAgentDatabaseLeases("worker-1", { env })).not.toThrow();
    } finally {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
      deletion.rollback();
    }
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
    "defers nested permission repair to the outer transaction boundary",
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
    expect(readSqliteNumberPragma(database.db, "auto_vacuum")).toBe(2);
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(readSqliteNumberPragma(database.db, "wal_autocheckpoint")).toBe(1000);
    const journalMode = database.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("backfills per-entry status while migrating a v6 agent database", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy
        .prepare(
          `INSERT INTO sessions (
             session_id, session_key, session_scope, created_at, updated_at, status
           ) VALUES (?, ?, 'conversation', ?, ?, ?)`,
        )
        .run("shared-session", "agent:worker-1:running", 10, 10, "done");
      legacy
        .prepare(
          `INSERT INTO session_entries (
             session_key, session_id, entry_json, updated_at, status
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "agent:worker-1:running",
          "shared-session",
          JSON.stringify({ sessionId: "shared-session", status: "running", updatedAt: 10 }),
          10,
          "running",
        );
      legacy.exec(`
        DROP INDEX idx_agent_session_entries_status;
        ALTER TABLE session_entries DROP COLUMN status;
        PRAGMA user_version = 6;
      `);
    } finally {
      legacy.close();
    }

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(
      migrated.db
        .prepare("SELECT status FROM session_nodes WHERE session_key = ?")
        .get("agent:worker-1:running"),
    ).toEqual({ status: "running" });
    expect(
      migrated.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("idx_agent_session_nodes_status"),
    ).toEqual({ name: "idx_agent_session_nodes_status" });
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("replaces the main v5 session indexes during migration", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const database = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = database.path;
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP INDEX idx_agent_session_entries_session_updated;
        DROP INDEX idx_agent_transcript_event_sequence;
        CREATE INDEX idx_agent_session_entries_session_id
          ON session_entries(session_id);
        PRAGMA user_version = 5;
      `);
    } finally {
      legacy.close();
    }

    const migrated = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const indexNames = migrated.db
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_agent_session_entries_session_id',
              'idx_agent_session_nodes_current_session_id',
              'idx_agent_transcript_event_sequence'
            )
          ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(indexNames).toEqual([
      "idx_agent_session_nodes_current_session_id",
      "idx_agent_transcript_event_sequence",
    ]);
    const transcriptIndex = migrated.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_agent_transcript_event_sequence") as { sql?: unknown } | undefined;
    expect(
      typeof transcriptIndex?.sql === "string"
        ? transcriptIndex.sql.replace(/\s+/g, " ").trim()
        : transcriptIndex?.sql,
    ).toContain("ON transcript_event_identities(session_id, event_type, seq DESC)");
    expect(readSqliteNumberPragma(migrated.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("repairs a same-name transcript uniqueness index before accepting writes", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const created = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = created.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createTranscriptIdempotencyIndexDrift(databasePath);

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const index = reopened.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_message_idempotency'",
      )
      .get() as { sql?: unknown };
    expect(index.sql).toContain(
      "ON transcript_event_identities(session_id, message_idempotency_key)",
    );
    expect(index.sql).toContain("WHERE message_idempotency_key IS NOT NULL");

    expect(() =>
      reopened.db
        .prepare(
          `INSERT INTO transcript_event_identities (
             session_id, event_id, seq, message_idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("session-1", "event-2", 2, "message-1", 2),
    ).toThrow(/UNIQUE constraint failed/iu);
  });

  it("repairs every canonical agent-state named unique index", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const created = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = created.path;
    const canonicalShape = normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(created.db));
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const drifted = new DatabaseSync(databasePath);
    try {
      expect(replaceNamedUniqueIndexesWithOrdinaryIndexes(drifted)).toHaveLength(5);
      expect(drifted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(drifted.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      drifted.close();
    }

    const reopened = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(normalizeSqliteSchemaShapeSql(collectSqliteSchemaShape(reopened.db))).toEqual(
      canonicalShape,
    );
  });

  it("rejects same-name transcript index drift when duplicate rows block repair", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const created = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = created.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createTranscriptIdempotencyIndexDrift(databasePath, { duplicateRows: true });

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /canonical unique index idx_agent_transcript_message_idempotency failed.*UNIQUE constraint failed/iu,
    );

    const { DatabaseSync } = requireNodeSqlite();
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_transcript_message_idempotency'",
          )
          .get(),
      ).toEqual({
        sql: expect.stringContaining("ON transcript_event_identities(session_id, event_id)"),
      });
      expect(
        after
          .prepare(
            "SELECT COUNT(*) AS count FROM transcript_event_identities WHERE message_idempotency_key = 'message-1'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'openclaw_probe_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      after.close();
    }
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
        agentDb
          .selectFrom("schema_meta")
          .select(["role", "schema_version", "agent_id", "app_version"]),
      ),
    ).toEqual({
      role: "agent",
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      agent_id: "worker-1",
      app_version: VERSION,
    });
  });

  it("adds transcript watermarks and session provenance to v4 session tables", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    openOpenClawAgentDatabase({ agentId: "worker-1", env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      ALTER TABLE sessions DROP COLUMN transcript_updated_at;
      ALTER TABLE sessions DROP COLUMN transcript_observed_at;
      ALTER TABLE sessions DROP COLUMN session_entry_provenance;
      ALTER TABLE sessions DROP COLUMN acp_owned;
      ALTER TABLE sessions DROP COLUMN plugin_owner_id;
      ALTER TABLE sessions DROP COLUMN hook_external_content_source;
      DELETE FROM schema_meta;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 4, 'worker-1', NULL, 1, 1);
      INSERT INTO sessions
        (session_id, session_key, created_at, updated_at)
      VALUES ('session-1', 'agent:worker-1:main', 10, 20);
      INSERT INTO sessions
        (session_id, session_key, created_at, updated_at)
      VALUES ('session-2', 'agent:worker-1:other', 10, 20);
      INSERT INTO session_entries
        (session_key, session_id, entry_json, updated_at)
      VALUES (
        'agent:worker-1:main',
        'session-1',
        '{"sessionId":"session-1","pluginOwnerId":"history-owner","hookExternalContentSource":"webhook","acp":{"backend":"acpx"}}',
        20
      );
      INSERT INTO transcript_events
        (session_id, seq, event_json, created_at)
      VALUES ('session-1', 0, '{"type":"custom"}', 1);
      PRAGMA user_version = 4;
    `);
    db.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = database.db.prepare("PRAGMA table_info(session_windows)").all() as Array<{
      name?: unknown;
    }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "transcript_observed_at",
        "transcript_updated_at",
        "session_entry_provenance",
        "acp_owned",
        "plugin_owner_id",
        "hook_external_content_source",
      ]),
    );
    expect(
      database.db
        .prepare(
          "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({
      transcript_observed_at: 20,
      transcript_updated_at: 1,
    });
    expect(
      database.db
        .prepare(
          "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
        )
        .get("session-2"),
    ).toEqual({
      transcript_observed_at: null,
      transcript_updated_at: null,
    });
    expect(
      database.db
        .prepare(
          "SELECT session_entry_provenance, acp_owned, plugin_owner_id, hook_external_content_source FROM session_windows WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({
      session_entry_provenance: 1,
      acp_owned: 1,
      plugin_owner_id: "history-owner",
      hook_external_content_source: "webhook",
    });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("adds transcript provenance when upgrading the v7 status schema", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    openOpenClawAgentDatabase({ agentId: "worker-1", env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      ALTER TABLE sessions DROP COLUMN session_entry_provenance;
      ALTER TABLE sessions DROP COLUMN acp_owned;
      ALTER TABLE sessions DROP COLUMN plugin_owner_id;
      ALTER TABLE sessions DROP COLUMN hook_external_content_source;
      ALTER TABLE conversations DROP COLUMN delivery_target;
      DELETE FROM schema_meta;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 7, 'worker-1', NULL, 1, 1);
      INSERT INTO sessions
        (session_id, session_key, created_at, updated_at, status)
      VALUES ('session-1', 'agent:worker-1:main', 10, 20, 'done');
      INSERT INTO session_entries
        (session_key, session_id, entry_json, updated_at, status)
      VALUES (
        'agent:worker-1:main',
        'session-1',
        '{"sessionId":"session-1","pluginOwnerId":"history-owner","acp":{"backend":"acpx"},"chatType":"direct","deliveryContext":{"channel":"reef","accountId":"default","to":"reef:peer-a"}}',
        20,
        'done'
      );
      PRAGMA user_version = 7;
    `);
    db.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(
      database.db
        .prepare("SELECT session_entry_provenance, acp_owned, plugin_owner_id FROM session_windows")
        .get(),
    ).toEqual({
      session_entry_provenance: 1,
      acp_owned: 1,
      plugin_owner_id: "history-owner",
    });
    expect(
      database.db
        .prepare(
          `SELECT sc.role, c.channel, c.peer_id, c.delivery_target
           FROM session_conversations AS sc
           JOIN conversations AS c ON c.conversation_id = sc.conversation_id`,
        )
        .get(),
    ).toEqual({
      role: "primary",
      channel: "reef",
      peer_id: "peer-a",
      delivery_target: "reef:peer-a",
    });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("adds the active transcript projection when upgrading v9 databases", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    openOpenClawAgentDatabase({ agentId: "worker-1", env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      DROP TABLE session_transcript_active_events;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_event_count;
      ALTER TABLE session_transcript_index_state DROP COLUMN active_message_count;
      DELETE FROM schema_meta;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 9, 'worker-1', NULL, 1, 1);
      INSERT INTO sessions
        (session_id, session_key, created_at, updated_at)
      VALUES ('session-1', 'agent:worker-1:main', 10, 20);
      INSERT INTO transcript_events
        (session_id, seq, event_json, created_at)
      VALUES
        ('session-1', 0, '{"type":"session","id":"session-1"}', 10),
        ('session-1', 1, '{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hello"}}', 20);
      INSERT INTO session_transcript_index_state
        (session_id, indexed_seq, leaf_event_id, needs_rebuild, updated_at)
      VALUES ('session-1', 1, 'm1', 0, 20);
      PRAGMA user_version = 9;
    `);
    db.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const columns = database.db
      .prepare("PRAGMA table_info(session_transcript_index_state)")
      .all() as Array<{ name?: unknown }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["active_event_count", "active_message_count"]),
    );
    expect(
      database.db
        .prepare(
          "SELECT indexed_seq, needs_rebuild, active_event_count, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({
      active_event_count: 0,
      active_message_count: 0,
      indexed_seq: 1,
      needs_rebuild: 1,
    });
    expect(
      database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_active_events'",
        )
        .get(),
    ).toEqual({ name: "session_transcript_active_events" });
    expect(
      database.db
        .prepare(
          "SELECT length(generation) AS generation_length FROM transcript_rewrite_watermarks WHERE session_id = ?",
        )
        .get("session-1"),
    ).toEqual({ generation_length: 32 });
    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("adds durable conversation delivery state when upgrading the canonical v10 schema", () => {
    const stateDir = createTempStateDir();
    const databasePath = path.join(
      stateDir,
      "agents",
      "worker-1",
      "agent",
      "openclaw-agent.sqlite",
    );
    openOpenClawAgentDatabase({ agentId: "worker-1", env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawAgentDatabasesForTest();
    downgradeCurrentAgentDatabaseToV13(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      DROP TABLE conversation_deliveries;
      ALTER TABLE conversations DROP COLUMN delivery_target;
      DELETE FROM schema_meta;
      INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', 'agent', 10, 'worker-1', NULL, 1, 1);
      INSERT INTO sessions
        (session_id, session_key, session_scope, created_at, updated_at, chat_type)
      VALUES ('session-1', 'agent:worker-1:main', 'shared-main', 10, 20, 'direct');
      INSERT INTO session_entries
        (session_key, session_id, entry_json, updated_at, status)
      VALUES (
        'agent:worker-1:main',
        'session-1',
        '{"sessionId":"session-1","chatType":"direct","deliveryContext":{"channel":"reef","accountId":"default","to":"reef:peer-a"}}',
        20,
        'done'
      );
      PRAGMA user_version = 10;
    `);
    db.close();

    const database = openOpenClawAgentDatabase({
      agentId: "worker-1",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(database.db.prepare("SELECT peer_id, delivery_target FROM conversations").get()).toEqual(
      { peer_id: "peer-a", delivery_target: "reef:peer-a" },
    );
    expect(
      database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_deliveries'",
        )
        .get(),
    ).toEqual({ name: "conversation_deliveries" });
    expect(() =>
      assertOpenClawAgentDatabaseForMaintenance(database.db, {
        agentId: "worker-1",
        pathname: database.path,
      }),
    ).not.toThrow();
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

    expect(readSqliteNumberPragma(database.db, "user_version")).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
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
          FROM session_windows
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
      .prepare("SELECT current_session_id, updated_at FROM session_nodes WHERE session_key = ?")
      .get("agent:worker-1:group:example");
    expect(route).toEqual({
      current_session_id: "session-1",
      updated_at: 20,
    });
    const sessionForeignKeys = database.db
      .prepare("PRAGMA foreign_key_list(session_windows)")
      .all() as
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

  it("rejects stale schema_meta indexes before writable initialization", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeSchemaMetaIndexDrift(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /integrity_check failed.*unsafe_schema_meta_role/iu,
    );
    const independentlyManaged = new DatabaseSync(databasePath);
    try {
      expect(() =>
        ensureOpenClawAgentDatabaseSchema(independentlyManaged, {
          agentId: "worker-1",
          env,
        }),
      ).toThrow(/integrity_check failed.*unsafe_schema_meta_role/iu);
    } finally {
      independentlyManaged.close();
    }
  });

  it("defers unrelated current-schema index corruption to background verification", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("runs full integrity before a pending agent schema migration", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    try {
      before.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
    } finally {
      before.close();
    }

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
  });

  it("runs full integrity before mutating a nonempty unversioned agent database", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);

    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(databasePath);
    try {
      before.exec("PRAGMA user_version = 0;");
    } finally {
      before.close();
    }

    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      /integrity_check failed.*missing from index unsafe_index_records_value/iu,
    );
  });

  it("defers current-schema foreign-key violations to background verification", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const created = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    const databasePath = created.path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const corrupted = new DatabaseSync(databasePath);
    try {
      corrupted.exec("PRAGMA foreign_keys = OFF;");
      corrupted
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("orphan-window", "missing-node", 1, 1);
      expect(corrupted.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(corrupted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(corrupted.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "session_windows",
        rowid: 1,
        parent: "session_nodes",
        fkid: 1,
      });
    } finally {
      corrupted.close();
    }

    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
    closeOpenClawAgentDatabasesForTest();

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA foreign_key_check").get()).toEqual({
        table: "session_windows",
        rowid: 1,
        parent: "session_nodes",
        fkid: 1,
      });
    } finally {
      after.close();
    }
  });

  it("latches newer per-agent schema failures before integrity scans", () => {
    const stateDir = createTempStateDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(databasePath);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
    db.close();

    let firstFailure: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "worker-1", env });
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({
      name: "SqliteSchemaVersionError",
      message: expect.stringContaining("https://docs.openclaw.ai/reference/database-schemas"),
    });

    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
    let secondFailure: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "worker-1", env });
    } catch (error) {
      secondFailure = error;
    }
    expect(secondFailure).toBe(firstFailure);

    clearOpenClawAgentDatabaseOpenFailure(databasePath);
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
