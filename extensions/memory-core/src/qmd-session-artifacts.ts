import fsSync from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { migrateSqliteSchemaToStrict } from "openclaw/plugin-sdk/plugin-state-runtime";

const QMD_SESSION_ARTIFACT_TABLE = "openclaw_qmd_session_artifacts";
const QMD_SESSION_ARTIFACT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${QMD_SESSION_ARTIFACT_TABLE} (
    collection TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    search_path TEXT NOT NULL,
    docid TEXT,
    memory_key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, artifact_path)
  ) STRICT;
`;

const QMD_SESSION_ARTIFACT_HIT: unique symbol = Symbol("openclaw.qmdSessionArtifactHit");

export type QmdSessionArtifactMapping = {
  agentId: string;
  archived: boolean;
  artifactPath: string;
  collection: string;
  memoryKey: string;
  searchPath: string;
  sessionId: string;
};

type QmdSessionArtifactLookup = {
  artifactPath?: string;
  collection?: string;
  docid?: string;
  indexPath: string;
  searchPath: string;
};

type QmdSessionArtifactIdentity = {
  agentId: string;
  archived: boolean;
  memoryKey: string;
  sessionId: string;
};

type QmdSessionArtifactHitCarrier = MemorySearchResult & {
  [QMD_SESSION_ARTIFACT_HIT]?: QmdSessionArtifactIdentity;
};

type QmdSessionArtifactRow = {
  agentId: string;
  artifact_path: string;
  archived: number;
  collection: string;
  docid: string | null;
  memoryKey: string;
  search_path: string;
  sessionId: string;
};

function ensureQmdSessionArtifactSchema(db: DatabaseSync): void {
  db.exec(QMD_SESSION_ARTIFACT_SCHEMA);
  try {
    db.exec(
      `ALTER TABLE ${QMD_SESSION_ARTIFACT_TABLE}
       ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {}
  const table = db
    .prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(QMD_SESSION_ARTIFACT_TABLE) as { strict?: unknown } | undefined;
  if (Number(table?.strict ?? 0) !== 1) {
    migrateSqliteSchemaToStrict(db, QMD_SESSION_ARTIFACT_SCHEMA, {
      databaseLabel: "QMD session artifact mappings",
    });
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_openclaw_qmd_session_artifacts_docid
     ON ${QMD_SESSION_ARTIFACT_TABLE} (docid)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_openclaw_qmd_session_artifacts_search_path
     ON ${QMD_SESSION_ARTIFACT_TABLE} (search_path)`,
  );
}

function openQmdSessionArtifactDb(indexPath: string, readOnly = false): DatabaseSync {
  const { DatabaseSync: SqliteDatabase } = requireNodeSqlite();
  if (!readOnly) {
    fsSync.mkdirSync(path.dirname(indexPath), { recursive: true });
  }
  const db = new SqliteDatabase(indexPath, { readOnly });
  db.exec("PRAGMA busy_timeout = 1000");
  return db;
}

export function attachQmdSessionArtifactHit(
  hit: MemorySearchResult,
  identity: QmdSessionArtifactIdentity,
): MemorySearchResult {
  Object.defineProperty(hit, QMD_SESSION_ARTIFACT_HIT, {
    configurable: true,
    enumerable: false,
    value: identity,
  });
  return hit;
}

export function copyQmdSessionArtifactHit(
  source: MemorySearchResult,
  target: MemorySearchResult,
): MemorySearchResult {
  const identity = readQmdSessionArtifactIdentity(source);
  return identity ? attachQmdSessionArtifactHit(target, identity) : target;
}

export function readQmdSessionArtifactIdentity(
  hit: MemorySearchResult,
): QmdSessionArtifactIdentity | null {
  return (hit as QmdSessionArtifactHitCarrier)[QMD_SESSION_ARTIFACT_HIT] ?? null;
}

export function replaceQmdSessionArtifactMappings(params: {
  collection: string;
  indexPath: string;
  mappings: QmdSessionArtifactMapping[];
}): void {
  const db = openQmdSessionArtifactDb(params.indexPath);
  let transactionStarted = false;
  try {
    ensureQmdSessionArtifactSchema(db);
    const deleteCollection = db.prepare(
      `DELETE FROM ${QMD_SESSION_ARTIFACT_TABLE} WHERE collection = ?`,
    );
    const upsert = db.prepare(
      `INSERT INTO ${QMD_SESSION_ARTIFACT_TABLE}
       (collection, artifact_path, search_path, docid, memory_key, agent_id, session_id, archived, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, artifact_path) DO UPDATE SET
         search_path=excluded.search_path,
         docid=NULL,
         memory_key=excluded.memory_key,
         agent_id=excluded.agent_id,
         session_id=excluded.session_id,
         archived=excluded.archived,
         updated_at=excluded.updated_at`,
    );
    db.exec("BEGIN");
    transactionStarted = true;
    deleteCollection.run(params.collection);
    const updatedAt = Date.now();
    for (const mapping of params.mappings) {
      upsert.run(
        mapping.collection,
        mapping.artifactPath,
        mapping.searchPath,
        mapping.memoryKey,
        mapping.agentId,
        mapping.sessionId,
        mapping.archived ? 1 : 0,
        updatedAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw err;
  } finally {
    db.close();
  }
}

export function refreshQmdSessionArtifactDocIds(params: {
  assertOwned: () => void;
  collection: string;
  indexPath: string;
}): void {
  const db = openQmdSessionArtifactDb(params.indexPath);
  let transactionStarted = false;
  try {
    ensureQmdSessionArtifactSchema(db);
    const rows = db
      .prepare(
        `SELECT d.hash AS docid, m.artifact_path AS artifact_path
         FROM ${QMD_SESSION_ARTIFACT_TABLE} m
         JOIN documents d
           ON d.collection = m.collection
          AND d.path = m.artifact_path
          AND d.active = 1
         WHERE m.collection = ?`,
      )
      .all(params.collection) as Array<{ artifact_path: string; docid: string }>;
    const updateDocId = db.prepare(
      `UPDATE ${QMD_SESSION_ARTIFACT_TABLE}
       SET docid = ?, updated_at = ?
       WHERE collection = ? AND artifact_path = ?`,
    );
    params.assertOwned();
    db.exec("BEGIN");
    transactionStarted = true;
    const updatedAt = Date.now();
    for (const row of rows) {
      params.assertOwned();
      updateDocId.run(row.docid, updatedAt, params.collection, row.artifact_path);
    }
    params.assertOwned();
    db.exec("COMMIT");
  } catch (err) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw err;
  } finally {
    db.close();
  }
}

export function resolveQmdSessionArtifactIdentity(
  lookup: QmdSessionArtifactLookup,
): QmdSessionArtifactIdentity | null {
  let db: DatabaseSync;
  try {
    db = openQmdSessionArtifactDb(lookup.indexPath, true);
  } catch {
    return null;
  }
  try {
    const row =
      findQmdSessionArtifactByDocId(db, lookup) ?? findQmdSessionArtifactByPath(db, lookup);
    return row
      ? {
          agentId: row.agentId,
          archived: row.archived === 1,
          memoryKey: row.memoryKey,
          sessionId: row.sessionId,
        }
      : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function findQmdSessionArtifactByDocId(
  db: DatabaseSync,
  lookup: QmdSessionArtifactLookup,
): QmdSessionArtifactRow | null {
  const docid = lookup.docid?.trim();
  if (!docid) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT collection, artifact_path, search_path, docid, archived, memory_key AS memoryKey,
              agent_id AS agentId, session_id AS sessionId
       FROM ${QMD_SESSION_ARTIFACT_TABLE}
       WHERE docid = ?`,
    )
    .all(docid) as QmdSessionArtifactRow[];
  return pickQmdSessionArtifactRow(rows, lookup);
}

function findQmdSessionArtifactByPath(
  db: DatabaseSync,
  lookup: QmdSessionArtifactLookup,
): QmdSessionArtifactRow | null {
  const rows = db
    .prepare(
      `SELECT collection, artifact_path, search_path, docid, archived, memory_key AS memoryKey,
              agent_id AS agentId, session_id AS sessionId
       FROM ${QMD_SESSION_ARTIFACT_TABLE}
       WHERE search_path = ?
          OR (collection = ? AND artifact_path = ?)`,
    )
    .all(
      lookup.searchPath,
      lookup.collection ?? "",
      lookup.artifactPath ?? "",
    ) as QmdSessionArtifactRow[];
  return pickQmdSessionArtifactRow(rows, lookup);
}

function pickQmdSessionArtifactRow(
  rows: QmdSessionArtifactRow[],
  lookup: QmdSessionArtifactLookup,
): QmdSessionArtifactRow | null {
  if (rows.length === 0) {
    return null;
  }
  const exact = rows.find((row) => {
    if (lookup.collection && row.collection !== lookup.collection) {
      return false;
    }
    if (lookup.artifactPath && row.artifact_path !== lookup.artifactPath) {
      return false;
    }
    return row.search_path === lookup.searchPath;
  });
  if (exact) {
    return exact;
  }
  return rows.length === 1 ? (rows[0] ?? null) : null;
}
