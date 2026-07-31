import type { DatabaseSync } from "node:sqlite";
import { readSqliteTableColumns } from "./openclaw-agent-db-session-migrations.js";

const SESSION_NODE_SCHEMA_VERSION = 14;

function migratedColumn(
  columns: ReadonlySet<string>,
  columnName: string,
  fallback: string,
): string {
  return columns.has(columnName) ? columnName : fallback;
}

function jsonText(path: string): string {
  return `CASE
    WHEN json_valid(entry_json) AND json_type(entry_json, '${path}') = 'text'
    THEN NULLIF(trim(CAST(json_extract(entry_json, '${path}') AS TEXT)), '')
    ELSE NULL
  END`;
}

function jsonNumber(path: string): string {
  return `CASE
    WHEN json_valid(entry_json) AND json_type(entry_json, '${path}') IN ('integer', 'real')
    THEN CAST(json_extract(entry_json, '${path}') AS INTEGER)
    ELSE NULL
  END`;
}

function createSessionNodes(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_nodes (
      session_key TEXT NOT NULL PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout')),
      created_at INTEGER,
      created_via TEXT CHECK (created_via IS NULL OR created_via IN ('operator', 'spawn', 'channel', 'cron', 'talk', 'run', 'plugin', 'internal')),
      created_actor_type TEXT CHECK (created_actor_type IS NULL OR created_actor_type IN ('human', 'agent', 'system')),
      created_actor_id TEXT,
      parent_session_key TEXT,
      spawned_by TEXT,
      fork_source_session_key TEXT,
      fork_source_session_id TEXT,
      fork_source_entry_id TEXT,
      label TEXT,
      display_name TEXT,
      category TEXT,
      icon TEXT,
      pinned_at INTEGER,
      archived_at INTEGER,
      last_read_at INTEGER,
      last_interaction_at INTEGER,
      last_activity_at INTEGER
    ) STRICT;
  `);
}

function backfillSessionNodes(db: DatabaseSync): void {
  const entryColumns = readSqliteTableColumns(db, "session_entries");
  if (entryColumns) {
    const status = migratedColumn(entryColumns, "status", "NULL");
    db.exec(`
      INSERT OR REPLACE INTO session_nodes (
        session_key, current_session_id, entry_json, updated_at, status,
        created_at, created_via, created_actor_type, created_actor_id,
        parent_session_key, spawned_by, fork_source_session_key,
        fork_source_session_id, fork_source_entry_id, label, display_name,
        category, icon, pinned_at, archived_at, last_read_at,
        last_interaction_at, last_activity_at
      )
      SELECT
        session_key,
        session_id,
        entry_json,
        updated_at,
        ${status},
        ${jsonNumber("$.createdAt")},
        CASE
          WHEN json_valid(entry_json)
            AND json_extract(entry_json, '$.createdVia') IN
              ('operator', 'spawn', 'channel', 'cron', 'talk', 'run', 'plugin', 'internal')
          THEN json_extract(entry_json, '$.createdVia')
          ELSE NULL
        END,
        CASE
          WHEN json_valid(entry_json)
            AND json_extract(entry_json, '$.createdActor.type') IN ('human', 'agent', 'system')
          THEN json_extract(entry_json, '$.createdActor.type')
          WHEN ${jsonText("$.createdBy.id")} IS NOT NULL THEN 'human'
          ELSE NULL
        END,
        COALESCE(${jsonText("$.createdActor.id")}, ${jsonText("$.createdBy.id")}),
        COALESCE(${jsonText("$.parentSessionKey")}, ${jsonText("$.spawnedBy")}),
        ${jsonText("$.spawnedBy")},
        ${jsonText("$.forkSource.sessionKey")},
        ${jsonText("$.forkSource.sessionId")},
        ${jsonText("$.forkSource.entryId")},
        ${jsonText("$.label")},
        ${jsonText("$.displayName")},
        ${jsonText("$.category")},
        ${jsonText("$.icon")},
        ${jsonNumber("$.pinnedAt")},
        ${jsonNumber("$.archivedAt")},
        ${jsonNumber("$.lastReadAt")},
        ${jsonNumber("$.lastInteractionAt")},
        ${jsonNumber("$.lastActivityAt")}
      FROM session_entries;
    `);
  }

  const routeColumns = readSqliteTableColumns(db, "session_routes");
  if (routeColumns) {
    db.exec(`
      INSERT OR IGNORE INTO session_nodes (
        session_key, current_session_id, entry_json, updated_at
      )
      SELECT session_key, session_id, '{}', updated_at
      FROM session_routes;
    `);
  }

  // Legacy history can contain a generation whose key has neither a live entry
  // nor a route. It still needs one node owner so the flipped FK can retain it.
  db.exec(`
    INSERT OR IGNORE INTO session_nodes (
      session_key, current_session_id, entry_json, updated_at
    )
    SELECT session_key, session_id, '{}', updated_at
    FROM sessions;
  `);
}

function migrateSessionWindows(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "sessions");
  if (!columns) {
    return;
  }
  const entryColumns = readSqliteTableColumns(db, "session_entries");
  const routeColumns = readSqliteTableColumns(db, "session_routes");
  // Keep owner preference local to each scalar query: supported SQLite 3.51
  // cannot resolve an outer column reference from a correlated ORDER BY.
  const entryOwner = entryColumns
    ? `(SELECT se.session_key
        FROM session_entries AS se
        INNER JOIN session_windows AS owner_window ON owner_window.session_id = se.session_id
        WHERE se.session_id = session_windows.session_id
        ORDER BY CASE WHEN se.session_key = owner_window.session_key THEN 0 ELSE 1 END,
                 se.updated_at DESC,
                 se.session_key ASC
        LIMIT 1)`
    : "NULL";
  const routeOwner = routeColumns
    ? `(SELECT sr.session_key
        FROM session_routes AS sr
        INNER JOIN session_windows AS owner_window ON owner_window.session_id = sr.session_id
        WHERE sr.session_id = session_windows.session_id
        ORDER BY CASE WHEN sr.session_key = owner_window.session_key THEN 0 ELSE 1 END,
                 sr.updated_at DESC,
                 sr.session_key ASC
        LIMIT 1)`
    : "NULL";
  const currentEntryJson = entryColumns
    ? `(SELECT se.entry_json
        FROM session_entries AS se
        INNER JOIN session_windows AS owner_window ON owner_window.session_id = se.session_id
        WHERE se.session_id = session_windows.session_id
        ORDER BY CASE WHEN se.session_key = owner_window.session_key THEN 0 ELSE 1 END,
                 se.updated_at DESC,
                 se.session_key ASC
        LIMIT 1)`
    : "NULL";

  // SQLite rewrites child FK targets on RENAME even while enforcement is off.
  // Rebuilding under the renamed owner keeps every transcript child attached.
  db.exec("ALTER TABLE sessions RENAME TO session_windows;");
  db.exec(`
    DROP TABLE IF EXISTS session_windows_new;
    CREATE TABLE session_windows_new (
      session_id TEXT NOT NULL PRIMARY KEY,
      session_key TEXT NOT NULL,
      previous_session_id TEXT,
      reason TEXT CHECK (reason IS NULL OR reason IN ('initial', 'reset', 'rollover', 'fork', 'rewind', 'switch', 'recovery', 'compaction')),
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
      FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE,
      FOREIGN KEY (primary_conversation_id) REFERENCES conversations(conversation_id) ON DELETE SET NULL
    ) STRICT;
    INSERT INTO session_windows_new (
      session_id, session_key, previous_session_id, reason, session_scope,
      created_at, updated_at, transcript_updated_at, transcript_observed_at,
      session_entry_provenance, acp_owned, plugin_owner_id,
      hook_external_content_source, started_at, ended_at, status, chat_type,
      channel, account_id, primary_conversation_id, model_provider, model,
      agent_harness_id, parent_session_key, spawned_by, display_name
    )
    SELECT
      session_id,
      COALESCE(${entryOwner}, ${routeOwner}, session_key),
      CASE
        WHEN json_valid(${currentEntryJson})
        THEN NULLIF(trim(CAST(json_extract(${currentEntryJson}, '$.previousSessionId') AS TEXT)), '')
        ELSE NULL
      END,
      NULL,
      ${migratedColumn(columns, "session_scope", "'conversation'")},
      created_at,
      updated_at,
      ${migratedColumn(columns, "transcript_updated_at", "NULL")},
      ${migratedColumn(columns, "transcript_observed_at", "NULL")},
      ${migratedColumn(columns, "session_entry_provenance", "0")},
      ${migratedColumn(columns, "acp_owned", "0")},
      ${migratedColumn(columns, "plugin_owner_id", "NULL")},
      ${migratedColumn(columns, "hook_external_content_source", "NULL")},
      ${migratedColumn(columns, "started_at", "NULL")},
      ${migratedColumn(columns, "ended_at", "NULL")},
      ${migratedColumn(columns, "status", "NULL")},
      ${migratedColumn(columns, "chat_type", "NULL")},
      ${migratedColumn(columns, "channel", "NULL")},
      ${migratedColumn(columns, "account_id", "NULL")},
      ${migratedColumn(columns, "primary_conversation_id", "NULL")},
      ${migratedColumn(columns, "model_provider", "NULL")},
      ${migratedColumn(columns, "model", "NULL")},
      ${migratedColumn(columns, "agent_harness_id", "NULL")},
      ${migratedColumn(columns, "parent_session_key", "NULL")},
      ${migratedColumn(columns, "spawned_by", "NULL")},
      ${migratedColumn(columns, "display_name", "NULL")}
    FROM session_windows;
    DROP TABLE session_windows;
    ALTER TABLE session_windows_new RENAME TO session_windows;
  `);
}

function renameTranscriptRewriteWatermarks(db: DatabaseSync): void {
  if (
    readSqliteTableColumns(db, "session_transcript_generations") &&
    !readSqliteTableColumns(db, "transcript_rewrite_watermarks")
  ) {
    db.exec("ALTER TABLE session_transcript_generations RENAME TO transcript_rewrite_watermarks;");
  }
}

function rebuildBoardTabs(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "board_tabs");
  if (!columns) {
    return;
  }
  if (readSqliteTableColumns(db, "board_widgets")) {
    db.exec(`
      DELETE FROM board_widgets
      WHERE NOT EXISTS (
        SELECT 1 FROM session_nodes WHERE session_nodes.session_key = board_widgets.session_key
      );
    `);
  }
  db.exec(`
    DROP TABLE IF EXISTS board_tabs_new;
    CREATE TABLE board_tabs_new (
      session_key TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      chat_dock TEXT NOT NULL DEFAULT 'right' CHECK (chat_dock IN ('left', 'right', 'bottom', 'hidden')),
      created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      PRIMARY KEY (session_key, tab_id),
      FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO board_tabs_new (
      session_key, tab_id, title, position, chat_dock, created_by, revision
    )
    SELECT b.session_key, b.tab_id, b.title, b.position, b.chat_dock, b.created_by, b.revision
    FROM board_tabs AS b
    INNER JOIN session_nodes AS n ON n.session_key = b.session_key;
    DROP TABLE board_tabs;
    ALTER TABLE board_tabs_new RENAME TO board_tabs;
  `);
}

function rebuildHeartbeatOutcomes(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "heartbeat_outcomes");
  if (!columns) {
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS heartbeat_outcomes_new;
    CREATE TABLE heartbeat_outcomes_new (
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
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO heartbeat_outcomes_new (
      session_key, run_session_key, outcome, summary, response_reason, priority,
      next_check, task_names_json, wake_source, wake_reason, occurred_at,
      context_run_id, context_claimed_at, updated_at
    )
    SELECT
      h.session_key,
      h.run_session_key,
      h.outcome,
      h.summary,
      ${migratedColumn(columns, "response_reason", "NULL")},
      ${migratedColumn(columns, "priority", "NULL")},
      ${migratedColumn(columns, "next_check", "NULL")},
      ${migratedColumn(columns, "task_names_json", "NULL")},
      ${migratedColumn(columns, "wake_source", "NULL")},
      ${migratedColumn(columns, "wake_reason", "NULL")},
      h.occurred_at,
      ${migratedColumn(columns, "context_run_id", "NULL")},
      ${migratedColumn(columns, "context_claimed_at", "NULL")},
      h.updated_at
    FROM heartbeat_outcomes AS h
    INNER JOIN session_nodes AS n ON n.session_key = h.session_key;
    DROP TABLE heartbeat_outcomes;
    ALTER TABLE heartbeat_outcomes_new RENAME TO heartbeat_outcomes;
  `);
}

function rebuildSessionMembers(db: DatabaseSync): void {
  if (!readSqliteTableColumns(db, "session_members")) {
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS session_members_new;
    CREATE TABLE session_members_new (
      session_key TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (session_key, identity_id),
      FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO session_members_new (session_key, identity_id, added_by, added_at)
    SELECT m.session_key, m.identity_id, m.added_by, m.added_at
    FROM session_members AS m
    INNER JOIN session_nodes AS n ON n.session_key = m.session_key;
    DROP TABLE session_members;
    ALTER TABLE session_members_new RENAME TO session_members;
  `);
}

function rebuildTranscriptIndexState(db: DatabaseSync): void {
  const columns = readSqliteTableColumns(db, "session_transcript_index_state");
  if (!columns) {
    return;
  }
  db.exec(`
    DROP TABLE IF EXISTS session_transcript_index_state_new;
    CREATE TABLE session_transcript_index_state_new (
      session_id TEXT NOT NULL PRIMARY KEY,
      indexed_seq INTEGER NOT NULL,
      leaf_event_id TEXT,
      needs_rebuild INTEGER NOT NULL DEFAULT 0,
      active_event_count INTEGER NOT NULL DEFAULT 0,
      active_message_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_windows(session_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO session_transcript_index_state_new (
      session_id, indexed_seq, leaf_event_id, needs_rebuild,
      active_event_count, active_message_count, updated_at
    )
    SELECT
      i.session_id,
      i.indexed_seq,
      ${migratedColumn(columns, "leaf_event_id", "NULL")},
      ${migratedColumn(columns, "needs_rebuild", "0")},
      ${migratedColumn(columns, "active_event_count", "0")},
      ${migratedColumn(columns, "active_message_count", "0")},
      i.updated_at
    FROM session_transcript_index_state AS i
    INNER JOIN session_windows AS w ON w.session_id = i.session_id;
    DROP TABLE session_transcript_index_state;
    ALTER TABLE session_transcript_index_state_new RENAME TO session_transcript_index_state;
  `);
}

/** Replace split entry/route roots with logical nodes and generation windows. */
export function migrateSessionNodesAndWindows(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= SESSION_NODE_SCHEMA_VERSION || !readSqliteTableColumns(db, "sessions")) {
    return;
  }
  createSessionNodes(db);
  backfillSessionNodes(db);
  migrateSessionWindows(db);
  renameTranscriptRewriteWatermarks(db);
  rebuildBoardTabs(db);
  rebuildHeartbeatOutcomes(db);
  rebuildSessionMembers(db);
  rebuildTranscriptIndexState(db);
  db.exec(`
    DROP TABLE IF EXISTS session_routes;
    DROP TABLE IF EXISTS session_entries;
  `);
}
