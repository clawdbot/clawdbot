import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  WorkboardArtifact,
  WorkboardAttachment,
  WorkboardCard,
  WorkboardComment,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardExecution,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardProof,
  WorkboardRunAttempt,
  WorkboardWorkerLog,
} from "@openclaw/workboard-contract";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  compileSqliteQueryBindings,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardOwnerClaimResult,
} from "./persistence-types.js";
import { workboardCardConsumesOwnerSlot, workboardCardSlotOwner } from "./store-constants.js";
const WORKBOARD_DB_RELATIVE_PATH = ["plugins", "workboard", "workboard.sqlite"] as const;
const SCHEMA_VERSION = 3;
const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;
type Row = Record<string, unknown>;
type WorkboardSqliteStores = {
  cards: WorkboardCardStore;
  boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
  subscriptions: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
  attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  dataVersion: () => number;
  close: () => void;
};

export function resolveWorkboardSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...WORKBOARD_DB_RELATIVE_PATH);
}

function jsonValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return JSON.parse(value) as unknown;
}

function stringValue(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(row: Row, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

function requiredString(row: Row, key: string): string {
  const value = stringValue(row, key);
  if (!value) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = numberValue(row, key);
  if (value === undefined) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

function optional<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function asBlobContent(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

function blobToBase64(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (typeof value === "string") {
    return Buffer.from(value).toString("base64");
  }
  return "";
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Row[]).flatMap((row) =>
      typeof row.name === "string" ? [row.name] : [],
    ),
  );
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  if (tableColumns(db, tableName).has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

const WORKBOARD_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS workboard_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_boards (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      icon TEXT,
      color TEXT,
      automation_job_id TEXT,
      default_workspace_json TEXT,
      orchestration_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      run_id TEXT,
      task_id TEXT,
      source_url TEXT,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      execution_id TEXT,
      execution_kind TEXT,
      execution_engine TEXT,
      execution_mode TEXT,
      execution_status TEXT,
      execution_model TEXT,
      execution_session_key TEXT,
      execution_run_id TEXT,
      execution_started_at INTEGER,
      execution_updated_at INTEGER,
      automation_json TEXT,
      claim_json TEXT,
      template_id TEXT,
      archived_at INTEGER,
      stale_json TEXT,
      lifecycle_status_source_updated_at INTEGER,
      failure_count INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_cards_board_status_idx
      ON workboard_cards(board_id, status, position);
    CREATE INDEX IF NOT EXISTS workboard_cards_session_idx
      ON workboard_cards(session_key, run_id);

    CREATE TABLE IF NOT EXISTS workboard_card_labels (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_events (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_events_card_idx
      ON workboard_card_events(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_attempts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      engine TEXT,
      mode TEXT,
      model TEXT,
      session_key TEXT,
      run_id TEXT,
      error TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_attempts_card_idx
      ON workboard_card_attempts(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_comments_card_idx
      ON workboard_card_comments(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_links (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      target_card_id TEXT,
      title TEXT,
      url TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_links_card_idx
      ON workboard_card_links(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_proof (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      command TEXT,
      url TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_proof_card_idx
      ON workboard_card_proof(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_artifacts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT,
      url TEXT,
      path TEXT,
      mime_type TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_artifacts_card_idx
      ON workboard_card_artifacts(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_card_diagnostics (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      actions_json TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_notifications (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sequence INTEGER,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_notifications_card_idx
      ON workboard_card_notifications(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_worker_logs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      session_key TEXT,
      run_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_worker_logs_card_idx
      ON workboard_worker_logs(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_worker_protocol (
      card_id TEXT PRIMARY KEY REFERENCES workboard_cards(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      detail TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_card_attachments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime_type TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workboard_card_attachments_card_idx
      ON workboard_card_attachments(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      content BLOB NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workboard_notification_subscriptions (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      card_id TEXT,
      session_key TEXT,
      run_id TEXT,
      target TEXT,
      event_kinds_json TEXT,
      last_event_at INTEGER,
      last_event_id TEXT,
      last_event_sequence INTEGER,
      delivered_event_ids_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `;

function ensureWorkboardSchema(db: DatabaseSync): void {
  db.exec(WORKBOARD_SCHEMA_SQL);
  ensureColumn(db, "workboard_boards", "automation_job_id", "automation_job_id TEXT");
  ensureColumn(
    db,
    "workboard_cards",
    "lifecycle_status_source_updated_at",
    "lifecycle_status_source_updated_at INTEGER",
  );
  const migrationId = `schema-${SCHEMA_VERSION}`;
  const current = db
    .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = ?")
    .get(migrationId);
  if (!current) {
    migrateSqliteSchemaToStrict(db, WORKBOARD_SCHEMA_SQL, {
      databaseLabel: "workboard database",
    });
    db.prepare(
      "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    ).run(migrationId, Date.now());
  }
}

function chmodIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function hardenWorkboardDatabaseFiles(dbPath: string): void {
  fs.chmodSync(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  chmodIfExists(dbPath, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-wal`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-shm`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-journal`, WORKBOARD_SQLITE_FILE_MODE);
}

function createDatabase(dbPath: string): {
  db: DatabaseSync;
  maintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
} {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: WORKBOARD_SQLITE_DIR_MODE });
  chmodIfExists(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", WORKBOARD_SQLITE_FILE_MODE));
  }
  const db = openNodeSqliteDatabase(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
      checkpointIntervalMs: 0,
      databaseLabel: "workboard database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureWorkboardSchema(db);
    hardenWorkboardDatabaseFiles(dbPath);
    return { db, maintenance };
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}

// Every child table a card row expands into. Reading one card issues one query per
// entry here; reading the whole board that way is a query per card per table, which
// is why the batch read path preloads them instead.
const CARD_CHILD_TABLES = [
  "workboard_card_labels",
  "workboard_card_events",
  "workboard_card_attempts",
  "workboard_card_comments",
  "workboard_card_links",
  "workboard_card_proof",
  "workboard_card_artifacts",
  "workboard_card_attachments",
  "workboard_worker_logs",
  "workboard_card_diagnostics",
  "workboard_card_notifications",
] as const;

type WorkboardCardDatabase = Record<
  (typeof CARD_CHILD_TABLES)[number] | "workboard_cards" | "workboard_worker_protocol",
  Row
>;

/**
 * Child rows for a whole batch of cards, grouped by card id.
 *
 * Present only on the batch read path. `lookup` passes none and keeps issuing the
 * per-card queries, which is already the cheapest shape for a single card.
 */
type CardChildRows = {
  byTable: Map<string, Map<string, Row[]>>;
  workerProtocol: Map<string, Row>;
};

function groupByCardId(rows: Iterable<Row>): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const cardId = stringValue(row, "card_id");
    if (!cardId) {
      continue;
    }
    const bucket = grouped.get(cardId);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(cardId, [row]);
    }
  }
  return grouped;
}

function loadCardChildRows(db: DatabaseSync): CardChildRows {
  // Group raw rows only: every preload must finish before card decoding can fail.
  const query = getNodeSqliteKysely<WorkboardCardDatabase>(db);
  const byTable = new Map<string, Map<string, Row[]>>();
  for (const table of CARD_CHILD_TABLES) {
    // Same order the per-card query produces, so grouped buckets stay ordinal-sorted.
    byTable.set(
      table,
      groupByCardId(
        iterateSqliteQuerySync(
          db,
          query.selectFrom(table).selectAll().orderBy("card_id", "asc").orderBy("ordinal", "asc"),
        ),
      ),
    );
  }
  const workerProtocol = new Map<string, Row>();
  for (const row of iterateSqliteQuerySync(
    db,
    query.selectFrom("workboard_worker_protocol").selectAll(),
  )) {
    const cardId = stringValue(row, "card_id");
    if (cardId) {
      workerProtocol.set(cardId, row);
    }
  }
  return { byTable, workerProtocol };
}

function childRows(
  db: DatabaseSync,
  table: string,
  cardId: string,
  preloaded?: CardChildRows,
): Row[] {
  const cached = preloaded?.byTable.get(table);
  if (cached) {
    const rows = cached.get(cardId) ?? [];
    // Each table is read once per card. Release the raw rows as the decoded card
    // is built instead of retaining both complete representations of the board.
    cached.delete(cardId);
    return rows;
  }
  // Finish native extraction before decoding; a later row can contain the first error.
  return db
    .prepare(`SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`)
    .all(cardId) as Row[];
}

function workerProtocolRow(
  db: DatabaseSync,
  cardId: string,
  preloaded?: CardChildRows,
): Row | undefined {
  if (preloaded) {
    const row = preloaded.workerProtocol.get(cardId);
    preloaded.workerProtocol.delete(cardId);
    return row;
  }
  return db.prepare("SELECT * FROM workboard_worker_protocol WHERE card_id = ?").get(cardId) as
    | Row
    | undefined;
}

function readLabels(db: DatabaseSync, cardId: string, preloaded?: CardChildRows): string[] {
  return childRows(db, "workboard_card_labels", cardId, preloaded).flatMap((row) => {
    const label = stringValue(row, "label");
    return label ? [label] : [];
  });
}

function readEvents(
  db: DatabaseSync,
  cardId: string,
  preloaded?: CardChildRows,
): WorkboardEvent[] | undefined {
  const events = childRows(db, "workboard_card_events", cardId, preloaded).map((row) => {
    const event: WorkboardEvent = {
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind") as WorkboardEvent["kind"],
      at: requiredNumber(row, "at"),
    };
    const fromStatus = stringValue(row, "from_status");
    const toStatus = stringValue(row, "to_status");
    const sessionKey = stringValue(row, "session_key");
    const runId = stringValue(row, "run_id");
    if (fromStatus) {
      event.fromStatus = fromStatus as WorkboardEvent["fromStatus"];
    }
    if (toStatus) {
      event.toStatus = toStatus as WorkboardEvent["toStatus"];
    }
    if (sessionKey) {
      event.sessionKey = sessionKey;
    }
    if (runId) {
      event.runId = runId;
    }
    return event;
  });
  return events.length > 0 ? events : undefined;
}

function readExecution(row: Row): WorkboardExecution | undefined {
  const id = stringValue(row, "execution_id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    mode: requiredString(row, "execution_mode") as WorkboardExecution["mode"],
    status: requiredString(row, "execution_status") as WorkboardExecution["status"],
    ...(stringValue(row, "execution_engine")
      ? { engine: stringValue(row, "execution_engine") }
      : {}),
    ...(stringValue(row, "execution_model") ? { model: stringValue(row, "execution_model") } : {}),
    ...(stringValue(row, "execution_session_key")
      ? { sessionKey: stringValue(row, "execution_session_key") }
      : {}),
    ...(stringValue(row, "execution_run_id")
      ? { runId: stringValue(row, "execution_run_id") }
      : {}),
    startedAt: requiredNumber(row, "execution_started_at"),
    updatedAt: requiredNumber(row, "execution_updated_at"),
  };
}

function readAttachment(row: Row): WorkboardAttachment {
  return {
    id: requiredString(row, "id"),
    cardId: requiredString(row, "card_id"),
    createdAt: requiredNumber(row, "created_at"),
    fileName: requiredString(row, "file_name"),
    byteSize: requiredNumber(row, "byte_size"),
    ...(stringValue(row, "mime_type") ? { mimeType: stringValue(row, "mime_type") } : {}),
    ...(stringValue(row, "note") ? { note: stringValue(row, "note") } : {}),
  };
}

function readMetadata(
  db: DatabaseSync,
  row: Row,
  preloaded?: CardChildRows,
): WorkboardMetadata | undefined {
  const cardId = requiredString(row, "id");
  const attempts = childRows(db, "workboard_card_attempts", cardId, preloaded).map((child) => {
    const entry: WorkboardRunAttempt = {
      id: requiredString(child, "id"),
      status: requiredString(child, "status") as WorkboardRunAttempt["status"],
      startedAt: requiredNumber(child, "started_at"),
    };
    const endedAt = numberValue(child, "ended_at");
    const engine = stringValue(child, "engine");
    const mode = stringValue(child, "mode");
    const model = stringValue(child, "model");
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    const error = stringValue(child, "error");
    if (endedAt !== undefined) {
      entry.endedAt = endedAt;
    }
    if (engine) {
      entry.engine = engine as WorkboardRunAttempt["engine"];
    }
    if (mode) {
      entry.mode = mode as WorkboardRunAttempt["mode"];
    }
    if (model) {
      entry.model = model;
    }
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    if (error) {
      entry.error = error;
    }
    return entry;
  });
  const comments = childRows(db, "workboard_card_comments", cardId, preloaded).map((child) => {
    const entry: WorkboardComment = {
      id: requiredString(child, "id"),
      body: requiredString(child, "body"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const updatedAt = numberValue(child, "updated_at");
    if (updatedAt !== undefined) {
      entry.updatedAt = updatedAt;
    }
    return entry;
  });
  const links = childRows(db, "workboard_card_links", cardId, preloaded).map((child) => {
    const entry: WorkboardLink = {
      id: requiredString(child, "id"),
      type: requiredString(child, "type") as WorkboardLink["type"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const targetCardId = stringValue(child, "target_card_id");
    const title = stringValue(child, "title");
    const url = stringValue(child, "url");
    if (targetCardId) {
      entry.targetCardId = targetCardId;
    }
    if (title) {
      entry.title = title;
    }
    if (url) {
      entry.url = url;
    }
    return entry;
  });
  const proof = childRows(db, "workboard_card_proof", cardId, preloaded).map((child) => {
    const entry: WorkboardProof = {
      id: requiredString(child, "id"),
      status: requiredString(child, "status") as WorkboardProof["status"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const command = stringValue(child, "command");
    const url = stringValue(child, "url");
    const note = stringValue(child, "note");
    if (label) {
      entry.label = label;
    }
    if (command) {
      entry.command = command;
    }
    if (url) {
      entry.url = url;
    }
    if (note) {
      entry.note = note;
    }
    return entry;
  });
  const artifacts = childRows(db, "workboard_card_artifacts", cardId, preloaded).map((child) => {
    const entry: WorkboardArtifact = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const url = stringValue(child, "url");
    const artifactPath = stringValue(child, "path");
    const mimeType = stringValue(child, "mime_type");
    if (label) {
      entry.label = label;
    }
    if (url) {
      entry.url = url;
    }
    if (artifactPath) {
      entry.path = artifactPath;
    }
    if (mimeType) {
      entry.mimeType = mimeType;
    }
    return entry;
  });
  const attachments = childRows(db, "workboard_card_attachments", cardId, preloaded).map(
    readAttachment,
  );
  const workerLogs = childRows(db, "workboard_worker_logs", cardId, preloaded).map((child) => {
    const entry: WorkboardWorkerLog = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
      level: requiredString(child, "level") as WorkboardWorkerLog["level"],
      message: requiredString(child, "message"),
    };
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    return entry;
  });
  const diagnostics = childRows(db, "workboard_card_diagnostics", cardId, preloaded).map(
    (child) => ({
      kind: requiredString(child, "kind") as WorkboardDiagnostic["kind"],
      severity: requiredString(child, "severity") as WorkboardDiagnostic["severity"],
      title: requiredString(child, "title"),
      detail: requiredString(child, "detail"),
      firstSeenAt: requiredNumber(child, "first_seen_at"),
      lastSeenAt: requiredNumber(child, "last_seen_at"),
      count: requiredNumber(child, "count"),
      actions: (parseJson(child.actions_json) as WorkboardDiagnostic["actions"] | undefined) ?? [],
    }),
  );
  const notifications = childRows(db, "workboard_card_notifications", cardId, preloaded).map(
    (child) => {
      const entry: WorkboardNotification = {
        id: requiredString(child, "id"),
        kind: requiredString(child, "kind") as WorkboardNotification["kind"],
        createdAt: requiredNumber(child, "created_at"),
        message: requiredString(child, "message"),
      };
      const sequence = numberValue(child, "sequence");
      const sessionKey = stringValue(child, "session_key");
      const runId = stringValue(child, "run_id");
      if (sequence !== undefined) {
        entry.sequence = sequence;
      }
      if (sessionKey) {
        entry.sessionKey = sessionKey;
      }
      if (runId) {
        entry.runId = runId;
      }
      return entry;
    },
  );
  const protocol = workerProtocolRow(db, cardId, preloaded);
  const automation = parseJson(row.automation_json) as WorkboardMetadata["automation"] | undefined;
  const claim = parseJson(row.claim_json) as WorkboardMetadata["claim"] | undefined;
  const stale = parseJson(row.stale_json) as WorkboardMetadata["stale"] | undefined;
  const lifecycleStatusSourceUpdatedAt = numberValue(row, "lifecycle_status_source_updated_at");
  return optional({
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(proof.length > 0 ? { proof } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(workerLogs.length > 0 ? { workerLogs } : {}),
    ...(protocol
      ? {
          workerProtocol: {
            state: requiredString(protocol, "state") as NonNullable<
              WorkboardMetadata["workerProtocol"]
            >["state"],
            updatedAt: requiredNumber(protocol, "updated_at"),
            ...(stringValue(protocol, "detail") ? { detail: stringValue(protocol, "detail") } : {}),
          },
        }
      : {}),
    ...(automation ? { automation } : {}),
    ...(claim ? { claim } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    ...(stringValue(row, "template_id")
      ? { templateId: stringValue(row, "template_id") as WorkboardMetadata["templateId"] }
      : {}),
    ...(numberValue(row, "archived_at") !== undefined
      ? { archivedAt: numberValue(row, "archived_at") }
      : {}),
    ...(stale ? { stale } : {}),
    ...(lifecycleStatusSourceUpdatedAt !== undefined ? { lifecycleStatusSourceUpdatedAt } : {}),
    ...(numberValue(row, "failure_count") !== undefined
      ? { failureCount: numberValue(row, "failure_count") }
      : {}),
  });
}

function readCard(db: DatabaseSync, row: Row, preloaded?: CardChildRows): WorkboardCard {
  const card: WorkboardCard = {
    id: requiredString(row, "id"),
    title: requiredString(row, "title"),
    status: requiredString(row, "status") as WorkboardCard["status"],
    priority: requiredString(row, "priority") as WorkboardCard["priority"],
    labels: readLabels(db, requiredString(row, "id"), preloaded),
    position: requiredNumber(row, "position"),
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
  };
  const metadata = readMetadata(db, row, preloaded);
  const events = readEvents(db, card.id, preloaded);
  const execution = readExecution(row);
  return {
    ...card,
    ...(stringValue(row, "notes") ? { notes: stringValue(row, "notes") } : {}),
    ...(stringValue(row, "agent_id") ? { agentId: stringValue(row, "agent_id") } : {}),
    ...(stringValue(row, "session_key") ? { sessionKey: stringValue(row, "session_key") } : {}),
    ...(stringValue(row, "run_id") ? { runId: stringValue(row, "run_id") } : {}),
    ...(stringValue(row, "task_id") ? { taskId: stringValue(row, "task_id") } : {}),
    ...(stringValue(row, "source_url") ? { sourceUrl: stringValue(row, "source_url") } : {}),
    ...(execution ? { execution } : {}),
    ...(numberValue(row, "started_at") !== undefined
      ? { startedAt: numberValue(row, "started_at") }
      : {}),
    ...(numberValue(row, "completed_at") !== undefined
      ? { completedAt: numberValue(row, "completed_at") }
      : {}),
    ...(events ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function bindNull(value: unknown): SQLInputValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return (value ?? null) as SQLInputValue;
  }
  return JSON.stringify(value);
}

function insertChildren<T>(
  db: DatabaseSync,
  table: (typeof CARD_CHILD_TABLES)[number],
  cardId: string,
  entries: readonly T[] | undefined,
  insert: (entry: T, ordinal: number) => void,
): void {
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<Record<typeof table, Row>>(db)
      .deleteFrom(table)
      .where("card_id", "=", cardId),
  );
  db.prepare(compiled.sql).run(...bind());
  entries?.forEach(insert);
}

function insertCard(db: DatabaseSync, card: WorkboardCard): void {
  const execution = card.execution;
  const metadata = card.metadata;
  const query = getNodeSqliteKysely<WorkboardCardDatabase>(db);
  // Keep payload getters and JSON serialization after native statement preparation.
  const parent = compileSqliteQueryBindings<void>((p) =>
    query
      .insertInto("workboard_cards")
      .values({
        id: p(() => card.id),
        board_id: p(() => cardBoardId(card)),
        title: p(() => card.title),
        notes: p(() => bindNull(card.notes)),
        status: p(() => card.status),
        priority: p(() => card.priority),
        agent_id: p(() => bindNull(card.agentId)),
        session_key: p(() => bindNull(card.sessionKey)),
        run_id: p(() => bindNull(card.runId)),
        task_id: p(() => bindNull(card.taskId)),
        source_url: p(() => bindNull(card.sourceUrl)),
        position: p(() => card.position),
        created_at: p(() => card.createdAt),
        updated_at: p(() => card.updatedAt),
        started_at: p(() => bindNull(card.startedAt)),
        completed_at: p(() => bindNull(card.completedAt)),
        execution_id: p(() => bindNull(execution?.id)),
        execution_kind: p(() => bindNull(execution?.kind)),
        execution_engine: p(() => bindNull(execution?.engine)),
        execution_mode: p(() => bindNull(execution?.mode)),
        execution_status: p(() => bindNull(execution?.status)),
        execution_model: p(() => bindNull(execution?.model)),
        execution_session_key: p(() => bindNull(execution?.sessionKey)),
        execution_run_id: p(() => bindNull(execution?.runId)),
        execution_started_at: p(() => bindNull(execution?.startedAt)),
        execution_updated_at: p(() => bindNull(execution?.updatedAt)),
        automation_json: p(() => jsonValue(metadata?.automation)),
        claim_json: p(() => jsonValue(metadata?.claim)),
        template_id: p(() => bindNull(metadata?.templateId)),
        archived_at: p(() => bindNull(metadata?.archivedAt)),
        stale_json: p(() => jsonValue(metadata?.stale)),
        lifecycle_status_source_updated_at: p(() =>
          bindNull(metadata?.lifecycleStatusSourceUpdatedAt),
        ),
        failure_count: p(() => bindNull(metadata?.failureCount)),
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet((eb) => ({
          board_id: eb.ref("excluded.board_id"),
          title: eb.ref("excluded.title"),
          notes: eb.ref("excluded.notes"),
          status: eb.ref("excluded.status"),
          priority: eb.ref("excluded.priority"),
          agent_id: eb.ref("excluded.agent_id"),
          session_key: eb.ref("excluded.session_key"),
          run_id: eb.ref("excluded.run_id"),
          task_id: eb.ref("excluded.task_id"),
          source_url: eb.ref("excluded.source_url"),
          position: eb.ref("excluded.position"),
          created_at: eb.ref("excluded.created_at"),
          updated_at: eb.ref("excluded.updated_at"),
          started_at: eb.ref("excluded.started_at"),
          completed_at: eb.ref("excluded.completed_at"),
          execution_id: eb.ref("excluded.execution_id"),
          execution_kind: eb.ref("excluded.execution_kind"),
          execution_engine: eb.ref("excluded.execution_engine"),
          execution_mode: eb.ref("excluded.execution_mode"),
          execution_status: eb.ref("excluded.execution_status"),
          execution_model: eb.ref("excluded.execution_model"),
          execution_session_key: eb.ref("excluded.execution_session_key"),
          execution_run_id: eb.ref("excluded.execution_run_id"),
          execution_started_at: eb.ref("excluded.execution_started_at"),
          execution_updated_at: eb.ref("excluded.execution_updated_at"),
          automation_json: eb.ref("excluded.automation_json"),
          claim_json: eb.ref("excluded.claim_json"),
          template_id: eb.ref("excluded.template_id"),
          archived_at: eb.ref("excluded.archived_at"),
          stale_json: eb.ref("excluded.stale_json"),
          lifecycle_status_source_updated_at: eb.ref("excluded.lifecycle_status_source_updated_at"),
          failure_count: eb.ref("excluded.failure_count"),
        })),
      ),
  );
  db.prepare(parent.compiled.sql).run(...parent.bind());

  insertChildren(db, "workboard_card_labels", card.id, card.labels, (label, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_labels").values({
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        label: p(() => label),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_events", card.id, card.events, (event, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_events").values({
        id: p(() => event.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        kind: p(() => event.kind),
        at: p(() => event.at),
        from_status: p(() => bindNull(event.fromStatus)),
        to_status: p(() => bindNull(event.toStatus)),
        session_key: p(() => bindNull(event.sessionKey)),
        run_id: p(() => bindNull(event.runId)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_attempts", card.id, metadata?.attempts, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_attempts").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        status: p(() => entry.status),
        started_at: p(() => entry.startedAt),
        ended_at: p(() => bindNull(entry.endedAt)),
        engine: p(() => bindNull(entry.engine)),
        mode: p(() => bindNull(entry.mode)),
        model: p(() => bindNull(entry.model)),
        session_key: p(() => bindNull(entry.sessionKey)),
        run_id: p(() => bindNull(entry.runId)),
        error: p(() => bindNull(entry.error)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_comments", card.id, metadata?.comments, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_comments").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        body: p(() => entry.body),
        created_at: p(() => entry.createdAt),
        updated_at: p(() => bindNull(entry.updatedAt)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_links", card.id, metadata?.links, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_links").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        type: p(() => entry.type),
        target_card_id: p(() => bindNull(entry.targetCardId)),
        title: p(() => bindNull(entry.title)),
        url: p(() => bindNull(entry.url)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_proof", card.id, metadata?.proof, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_proof").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        status: p(() => entry.status),
        label: p(() => bindNull(entry.label)),
        command: p(() => bindNull(entry.command)),
        url: p(() => bindNull(entry.url)),
        note: p(() => bindNull(entry.note)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(db, "workboard_card_artifacts", card.id, metadata?.artifacts, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_card_artifacts").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        label: p(() => bindNull(entry.label)),
        url: p(() => bindNull(entry.url)),
        path: p(() => bindNull(entry.path)),
        mime_type: p(() => bindNull(entry.mimeType)),
        created_at: p(() => entry.createdAt),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  insertChildren(
    db,
    "workboard_card_attachments",
    card.id,
    metadata?.attachments,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_attachments").values({
          id: p(() => entry.id),
          card_id: p(() => entry.cardId),
          ordinal: p(() => ordinal),
          file_name: p(() => entry.fileName),
          byte_size: p(() => entry.byteSize),
          mime_type: p(() => bindNull(entry.mimeType)),
          note: p(() => bindNull(entry.note)),
          created_at: p(() => entry.createdAt),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(
    db,
    "workboard_card_diagnostics",
    card.id,
    metadata?.diagnostics,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_diagnostics").values({
          card_id: p(() => card.id),
          ordinal: p(() => ordinal),
          kind: p(() => entry.kind),
          severity: p(() => entry.severity),
          title: p(() => entry.title),
          detail: p(() => entry.detail),
          first_seen_at: p(() => entry.firstSeenAt),
          last_seen_at: p(() => entry.lastSeenAt),
          count: p(() => entry.count),
          actions_json: p(() => JSON.stringify(entry.actions)),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(
    db,
    "workboard_card_notifications",
    card.id,
    metadata?.notifications,
    (entry, ordinal) => {
      const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
        query.insertInto("workboard_card_notifications").values({
          id: p(() => entry.id),
          card_id: p(() => card.id),
          ordinal: p(() => ordinal),
          kind: p(() => entry.kind),
          message: p(() => entry.message),
          created_at: p(() => entry.createdAt),
          sequence: p(() => bindNull(entry.sequence)),
          session_key: p(() => bindNull(entry.sessionKey)),
          run_id: p(() => bindNull(entry.runId)),
        }),
      );
      db.prepare(compiled.sql).run(...bind());
    },
  );
  insertChildren(db, "workboard_worker_logs", card.id, metadata?.workerLogs, (entry, ordinal) => {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_worker_logs").values({
        id: p(() => entry.id),
        card_id: p(() => card.id),
        ordinal: p(() => ordinal),
        level: p(() => entry.level),
        message: p(() => entry.message),
        created_at: p(() => entry.createdAt),
        session_key: p(() => bindNull(entry.sessionKey)),
        run_id: p(() => bindNull(entry.runId)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  });
  const protocolDelete = compileSqliteQueryBindings<void>((p) =>
    query.deleteFrom("workboard_worker_protocol").where(
      "card_id",
      "=",
      p(() => card.id),
    ),
  );
  db.prepare(protocolDelete.compiled.sql).run(...protocolDelete.bind());
  if (metadata?.workerProtocol) {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      query.insertInto("workboard_worker_protocol").values({
        card_id: p(() => card.id),
        state: p(() => metadata.workerProtocol!.state),
        updated_at: p(() => metadata.workerProtocol!.updatedAt),
        detail: p(() => bindNull(metadata.workerProtocol!.detail)),
      }),
    );
    db.prepare(compiled.sql).run(...bind());
  }
}

class WorkboardSqliteCardStore implements WorkboardCardStore {
  constructor(private readonly db: DatabaseSync) {}

  private matchesUpdatedAt(key: string, expectedUpdatedAt: number): boolean {
    const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
      getNodeSqliteKysely<WorkboardCardDatabase>(this.db)
        .selectFrom("workboard_cards")
        .select("updated_at")
        .where(
          "id",
          "=",
          parameter((value) => value),
        ),
    );
    const current = this.db.prepare(compiled.sql).get(...bind(key));
    return isRecord(current) && numberValue(current, "updated_at") === expectedUpdatedAt;
  }

  private validatePayload(key: string, value: PersistedWorkboardCard): void {
    if (value.version !== 1 || value.card.id !== key) {
      throw new Error("invalid workboard card payload");
    }
  }

  async register(key: string, value: PersistedWorkboardCard): Promise<void> {
    this.validatePayload(key, value);
    runSqliteImmediateTransactionSync(this.db, () => insertCard(this.db, value.card));
  }

  async registerIfAbsent(key: string, value: PersistedWorkboardCard): Promise<boolean> {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM workboard_cards WHERE id = ?").get(key)) {
        return false;
      }
      insertCard(this.db, value.card);
      return true;
    });
  }

  async registerIfUpdatedAt(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
  ): Promise<boolean> {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (!this.matchesUpdatedAt(key, expectedUpdatedAt)) {
        return false;
      }
      insertCard(this.db, value.card);
      return true;
    });
  }

  async claimIfOwnerAvailable(
    key: string,
    value: PersistedWorkboardCard,
    expectedUpdatedAt: number,
    ownerId: string,
    now: number,
  ): Promise<WorkboardOwnerClaimResult> {
    this.validatePayload(key, value);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (!this.matchesUpdatedAt(key, expectedUpdatedAt)) {
        return "conflict";
      }
      const rows: Row[] = this.db.prepare("SELECT * FROM workboard_cards WHERE id <> ?").all(key);
      const preloaded = loadCardChildRows(this.db);
      for (const row of rows) {
        const card = readCard(this.db, row, preloaded);
        if (workboardCardConsumesOwnerSlot(card, now) && workboardCardSlotOwner(card) === ownerId) {
          return "owner_busy";
        }
      }
      insertCard(this.db, value.card);
      return "updated";
    });
  }

  async deleteIfUpdatedAt(key: string, expectedUpdatedAt: number): Promise<boolean> {
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (!this.matchesUpdatedAt(key, expectedUpdatedAt)) {
        return false;
      }
      this.deleteCard(key);
      return true;
    });
  }

  async lookup(key: string): Promise<PersistedWorkboardCard | undefined> {
    const row = this.db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(key) as
      | Row
      | undefined;
    return row ? { version: 1, card: readCard(this.db, row) } : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const result = runSqliteImmediateTransactionSync(this.db, () => this.deleteCard(key));
    return result.changes > 0;
  }

  private deleteCard(key: string) {
    this.db
      .prepare(
        `
          DELETE FROM workboard_attachment_blobs
          WHERE attachment_id IN (
            SELECT id FROM workboard_card_attachments WHERE card_id = ?
          )
        `,
      )
      .run(key);
    return this.db.prepare("DELETE FROM workboard_cards WHERE id = ?").run(key);
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardCard }>> {
    const rows = this.db
      .prepare("SELECT * FROM workboard_cards ORDER BY created_at ASC, id ASC")
      .all() as Row[];
    // One query per child table for the whole board instead of one per table per card.
    // node:sqlite is synchronous, so those queries run on the event loop thread.
    const preloaded = loadCardChildRows(this.db);
    return rows.map((row) => ({
      key: requiredString(row, "id"),
      value: { version: 1, card: readCard(this.db, row, preloaded) },
    }));
  }

  async listBoardAggregates() {
    const rows = this.db
      .prepare(
        `
          SELECT
            board_id,
            status,
            COUNT(*) AS total,
            SUM(CASE WHEN archived_at IS NOT NULL AND archived_at <> 0 THEN 1 ELSE 0 END) AS archived,
            MAX(updated_at) AS updated_at
          FROM workboard_cards
          GROUP BY board_id, status
          ORDER BY board_id ASC, status ASC
        `,
      )
      .all() as Row[];
    return rows.map((row) => ({
      boardId: requiredString(row, "board_id"),
      status: requiredString(row, "status") as WorkboardCard["status"],
      total: requiredNumber(row, "total"),
      archived: requiredNumber(row, "archived"),
      updatedAt: requiredNumber(row, "updated_at"),
    }));
  }
}

function readBoard(row: Row): PersistedWorkboardBoard {
  const defaultWorkspace = parseJson(row.default_workspace_json) as
    | PersistedWorkboardBoard["board"]["defaultWorkspace"]
    | undefined;
  const orchestration = parseJson(row.orchestration_json) as
    | PersistedWorkboardBoard["board"]["orchestration"]
    | undefined;
  return {
    version: 1,
    board: {
      id: requiredString(row, "id"),
      ...(stringValue(row, "name") ? { name: stringValue(row, "name") } : {}),
      ...(stringValue(row, "description") ? { description: stringValue(row, "description") } : {}),
      ...(stringValue(row, "icon") ? { icon: stringValue(row, "icon") } : {}),
      ...(stringValue(row, "color") ? { color: stringValue(row, "color") } : {}),
      ...(stringValue(row, "automation_job_id")
        ? { automationJobId: stringValue(row, "automation_job_id") }
        : {}),
      ...(defaultWorkspace ? { defaultWorkspace } : {}),
      ...(orchestration ? { orchestration } : {}),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
      ...(numberValue(row, "archived_at") !== undefined
        ? { archivedAt: numberValue(row, "archived_at") }
        : {}),
    },
  };
}

class WorkboardSqliteBoardStore implements WorkboardKeyedStore<PersistedWorkboardBoard> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{ workboard_boards: Row }>(db)
      .selectFrom("workboard_boards")
      .selectAll();
  }

  async register(key: string, value: PersistedWorkboardBoard): Promise<void> {
    if (value.version !== 1 || value.board.id !== key) {
      throw new Error("invalid workboard board payload");
    }
    const board = value.board;
    // Native preparation must precede payload getters and JSON serialization.
    const { compiled, bind } = compileSqliteQueryBindings<void>((parameter) =>
      getNodeSqliteKysely<{ workboard_boards: Row }>(this.db)
        .insertInto("workboard_boards")
        .values({
          id: parameter(() => board.id),
          name: parameter(() => bindNull(board.name)),
          description: parameter(() => bindNull(board.description)),
          icon: parameter(() => bindNull(board.icon)),
          color: parameter(() => bindNull(board.color)),
          automation_job_id: parameter(() => bindNull(board.automationJobId)),
          default_workspace_json: parameter(() => jsonValue(board.defaultWorkspace)),
          orchestration_json: parameter(() => jsonValue(board.orchestration)),
          created_at: parameter(() => board.createdAt),
          updated_at: parameter(() => board.updatedAt),
          archived_at: parameter(() => bindNull(board.archivedAt)),
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet((eb) => ({
            name: eb.ref("excluded.name"),
            description: eb.ref("excluded.description"),
            icon: eb.ref("excluded.icon"),
            color: eb.ref("excluded.color"),
            automation_job_id: eb.ref("excluded.automation_job_id"),
            default_workspace_json: eb.ref("excluded.default_workspace_json"),
            orchestration_json: eb.ref("excluded.orchestration_json"),
            created_at: eb.ref("excluded.created_at"),
            updated_at: eb.ref("excluded.updated_at"),
            archived_at: eb.ref("excluded.archived_at"),
          })),
        ),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  async lookup(key: string): Promise<PersistedWorkboardBoard | undefined> {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("id", "=", key));
    return row ? readBoard(row) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM workboard_boards WHERE id = ?").run(key);
    return result.changes > 0;
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardBoard }>> {
    return Array.from(
      iterateSqliteQuerySync(this.db, this.rowsQuery.orderBy("id", "asc")),
      (row) => ({
        key: requiredString(row, "id"),
        value: readBoard(row),
      }),
    );
  }
}

function readSubscription(row: Row): PersistedWorkboardNotificationSubscription {
  const eventKinds = parseJson(row.event_kinds_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["eventKinds"]
    | undefined;
  const deliveredEventIds = parseJson(row.delivered_event_ids_json) as
    | PersistedWorkboardNotificationSubscription["subscription"]["deliveredEventIds"]
    | undefined;
  return {
    version: 1,
    subscription: {
      id: requiredString(row, "id"),
      boardId: requiredString(row, "board_id"),
      ...(stringValue(row, "card_id") ? { cardId: stringValue(row, "card_id") } : {}),
      ...(stringValue(row, "session_key") ? { sessionKey: stringValue(row, "session_key") } : {}),
      ...(stringValue(row, "run_id") ? { runId: stringValue(row, "run_id") } : {}),
      ...(stringValue(row, "target") ? { target: stringValue(row, "target") } : {}),
      ...(eventKinds ? { eventKinds } : {}),
      ...(numberValue(row, "last_event_at") !== undefined
        ? { lastEventAt: numberValue(row, "last_event_at") }
        : {}),
      ...(stringValue(row, "last_event_id")
        ? { lastEventId: stringValue(row, "last_event_id") }
        : {}),
      ...(numberValue(row, "last_event_sequence") !== undefined
        ? { lastEventSequence: numberValue(row, "last_event_sequence") }
        : {}),
      ...(deliveredEventIds ? { deliveredEventIds } : {}),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
    },
  };
}

class WorkboardSqliteSubscriptionStore implements WorkboardKeyedStore<PersistedWorkboardNotificationSubscription> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(db)
      .selectFrom("workboard_notification_subscriptions")
      .selectAll();
  }

  async register(key: string, value: PersistedWorkboardNotificationSubscription): Promise<void> {
    if (value.version !== 1 || value.subscription.id !== key) {
      throw new Error("invalid workboard notification subscription payload");
    }
    const subscription = value.subscription;
    // Cursor fields must bind NULL when omitted, after native preparation succeeds.
    const { compiled, bind } = compileSqliteQueryBindings<void>((parameter) =>
      getNodeSqliteKysely<{ workboard_notification_subscriptions: Row }>(this.db)
        .insertInto("workboard_notification_subscriptions")
        .values({
          id: parameter(() => subscription.id),
          board_id: parameter(() => subscription.boardId),
          card_id: parameter(() => bindNull(subscription.cardId)),
          session_key: parameter(() => bindNull(subscription.sessionKey)),
          run_id: parameter(() => bindNull(subscription.runId)),
          target: parameter(() => bindNull(subscription.target)),
          event_kinds_json: parameter(() => jsonValue(subscription.eventKinds)),
          last_event_at: parameter(() => bindNull(subscription.lastEventAt)),
          last_event_id: parameter(() => bindNull(subscription.lastEventId)),
          last_event_sequence: parameter(() => bindNull(subscription.lastEventSequence)),
          delivered_event_ids_json: parameter(() => jsonValue(subscription.deliveredEventIds)),
          created_at: parameter(() => subscription.createdAt),
          updated_at: parameter(() => subscription.updatedAt),
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet((eb) => ({
            board_id: eb.ref("excluded.board_id"),
            card_id: eb.ref("excluded.card_id"),
            session_key: eb.ref("excluded.session_key"),
            run_id: eb.ref("excluded.run_id"),
            target: eb.ref("excluded.target"),
            event_kinds_json: eb.ref("excluded.event_kinds_json"),
            last_event_at: eb.ref("excluded.last_event_at"),
            last_event_id: eb.ref("excluded.last_event_id"),
            last_event_sequence: eb.ref("excluded.last_event_sequence"),
            delivered_event_ids_json: eb.ref("excluded.delivered_event_ids_json"),
            created_at: eb.ref("excluded.created_at"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  async lookup(key: string): Promise<PersistedWorkboardNotificationSubscription | undefined> {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("id", "=", key));
    return row ? readSubscription(row) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM workboard_notification_subscriptions WHERE id = ?")
      .run(key);
    return result.changes > 0;
  }

  async entries(): Promise<
    Array<{ key: string; value: PersistedWorkboardNotificationSubscription }>
  > {
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.rowsQuery.orderBy("created_at", "asc").orderBy("id", "asc"),
      ),
      (row) => ({
        key: requiredString(row, "id"),
        value: readSubscription(row),
      }),
    );
  }
}

function readPersistedAttachment(row: Row): PersistedWorkboardAttachment {
  return {
    version: 1,
    attachment: readAttachment(row),
    contentBase64: blobToBase64(row.content),
  };
}

class WorkboardSqliteAttachmentStore implements WorkboardKeyedStore<PersistedWorkboardAttachment> {
  private readonly rowsQuery;

  constructor(private readonly db: DatabaseSync) {
    this.rowsQuery = getNodeSqliteKysely<{
      workboard_card_attachments: Row;
      workboard_attachment_blobs: Row;
    }>(db)
      .selectFrom("workboard_card_attachments as a")
      .innerJoin("workboard_attachment_blobs as b", "b.attachment_id", "a.id")
      .selectAll("a")
      .select("b.content");
  }

  async register(key: string, value: PersistedWorkboardAttachment): Promise<void> {
    if (value.version !== 1 || value.attachment.id !== key) {
      throw new Error("invalid workboard attachment payload");
    }
    const attachment = value.attachment;
    this.db
      .prepare(
        `
          INSERT INTO workboard_attachment_blobs (attachment_id, content)
          VALUES (?, ?)
          ON CONFLICT(attachment_id) DO UPDATE SET content = excluded.content
        `,
      )
      .run(attachment.id, asBlobContent(value.contentBase64));
  }

  async lookup(key: string): Promise<PersistedWorkboardAttachment | undefined> {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.rowsQuery.where("a.id", "=", key));
    return row ? readPersistedAttachment(row) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const deleted = runSqliteImmediateTransactionSync(this.db, () => {
      this.db.prepare("DELETE FROM workboard_attachment_blobs WHERE attachment_id = ?").run(key);
      return this.db.prepare("DELETE FROM workboard_card_attachments WHERE id = ?").run(key);
    });
    return deleted.changes > 0;
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardAttachment }>> {
    // Decode each BLOB before advancing so the list never retains a second full raw payload copy.
    return Array.from(
      iterateSqliteQuerySync(
        this.db,
        this.rowsQuery.orderBy("a.created_at", "asc").orderBy("a.id", "asc"),
      ),
      (row) => ({
        key: requiredString(row, "id"),
        value: readPersistedAttachment(row),
      }),
    );
  }
}

export function createWorkboardSqliteStores(
  options: {
    dbPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): WorkboardSqliteStores {
  const { db, maintenance } = createDatabase(
    options.dbPath ?? resolveWorkboardSqlitePath(options.env),
  );
  return {
    cards: new WorkboardSqliteCardStore(db),
    boards: new WorkboardSqliteBoardStore(db),
    subscriptions: new WorkboardSqliteSubscriptionStore(db),
    attachments: new WorkboardSqliteAttachmentStore(db),
    // This connection-local primitive changes only after another connection commits.
    dataVersion: () =>
      requiredNumber(db.prepare("PRAGMA data_version").get() as Row, "data_version"),
    close: () => {
      maintenance.close();
      db.close();
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
