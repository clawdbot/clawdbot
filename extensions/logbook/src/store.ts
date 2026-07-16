// Logbook SQLite store: frames on disk, everything else in one plugin-owned DB.
// Uses node:sqlite prepared statements directly (extension-local store, same
// pattern as memory-core/imessage); the shared Kysely helpers are core-only.
import { chmodSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookDayStats,
  LogbookDistraction,
  LogbookFrame,
  LogbookObservation,
} from "./types.js";

type SqliteModule = typeof import("node:sqlite");
type Database = import("node:sqlite").DatabaseSync;

function loadNodeSqlite(): SqliteModule {
  const req = createRequire(import.meta.url);
  return req("node:sqlite") as SqliteModule;
}

const LOGBOOK_SCHEMA_VERSION = 1;
const LOGBOOK_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  error TEXT,
  frame_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_batches_day ON batches (day, start_ms);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  screen_index INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  idle INTEGER NOT NULL DEFAULT 0 CHECK (idle IN (0, 1)),
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_frames_day ON frames (day, captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_frames_unbatched ON frames (batch_id) WHERE batch_id IS NULL;
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_observations_day ON observations (day, start_ms);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other',
  app_primary TEXT,
  app_secondary TEXT,
  distractions TEXT NOT NULL DEFAULT '[]',
  keyframe_id INTEGER REFERENCES frames(id) ON DELETE SET NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_cards_day ON cards (day, start_ms);
CREATE TABLE IF NOT EXISTS standups (
  day TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
`;

type FrameRow = {
  id: number;
  captured_at_ms: number;
  day: string;
  path: string;
  screen_index: number;
  width: number | null;
  height: number | null;
  byte_size: number;
  idle: number;
};

type BatchRow = {
  id: number;
  day: string;
  start_ms: number;
  end_ms: number;
  status: LogbookBatchStatus;
  error: string | null;
  frame_count: number;
  model: string | null;
};

type CardRow = {
  id: number;
  day: string;
  start_ms: number;
  end_ms: number;
  title: string;
  summary: string;
  detail: string;
  category: string;
  app_primary: string | null;
  app_secondary: string | null;
  distractions: string;
  keyframe_id: number | null;
};

function toFrame(row: FrameRow): LogbookFrame {
  return {
    id: row.id,
    capturedAtMs: row.captured_at_ms,
    day: row.day,
    path: row.path,
    screenIndex: row.screen_index,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    byteSize: row.byte_size,
    idle: row.idle === 1,
  };
}

function toBatch(row: BatchRow): LogbookBatch {
  return {
    id: row.id,
    day: row.day,
    startMs: row.start_ms,
    endMs: row.end_ms,
    status: row.status,
    error: row.error ?? undefined,
    frameCount: row.frame_count,
    model: row.model ?? undefined,
  };
}

function parseDistractions(raw: string): LogbookDistraction[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is LogbookDistraction =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as LogbookDistraction).title === "string" &&
        typeof (entry as LogbookDistraction).startMs === "number" &&
        typeof (entry as LogbookDistraction).endMs === "number",
    );
  } catch {
    return [];
  }
}

function toCard(row: CardRow): LogbookCard {
  return {
    id: row.id,
    day: row.day,
    startMs: row.start_ms,
    endMs: row.end_ms,
    title: row.title,
    summary: row.summary,
    detail: row.detail,
    category: row.category,
    appPrimary: row.app_primary ?? undefined,
    appSecondary: row.app_secondary ?? undefined,
    distractions: parseDistractions(row.distractions),
    keyframeId: row.keyframe_id ?? undefined,
  };
}

/** Formats an epoch-ms timestamp as a local-time YYYY-MM-DD day key. */
export function dayKeyFor(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

export class LogbookStore {
  private readonly db: Database;
  private readonly walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
  readonly framesDir: string;

  constructor(readonly dataDir: string) {
    // Frames and the DB hold raw screen contents; keep everything owner-only
    // even when the surrounding state dir is more permissive.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.framesDir = path.join(dataDir, "frames");
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    chmodSync(this.framesDir, 0o700);
    const { DatabaseSync } = loadNodeSqlite();
    const dbPath = path.join(dataDir, "logbook.sqlite");
    const db = new DatabaseSync(dbPath);
    let walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
    try {
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(dbPath, 0o600);
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      const versionRow = db.prepare("PRAGMA user_version").get() as
        | { user_version?: unknown }
        | undefined;
      const schemaVersion = Number(versionRow?.user_version ?? 0);
      if (schemaVersion > LOGBOOK_SCHEMA_VERSION) {
        throw new Error(
          `Logbook database uses newer schema version ${schemaVersion}; this build supports ${LOGBOOK_SCHEMA_VERSION}`,
        );
      }
      db.exec(SCHEMA);
      if (schemaVersion < LOGBOOK_SCHEMA_VERSION) {
        migrateSqliteSchemaToStrict(db, SCHEMA, { databaseLabel: dbPath });
        db.exec(`PRAGMA user_version = ${LOGBOOK_SCHEMA_VERSION};`);
      }
    } catch (error) {
      walMaintenance?.close();
      db.close();
      throw error;
    }
    if (!walMaintenance) {
      db.close();
      throw new Error("Logbook SQLite maintenance failed to initialize");
    }
    this.db = db;
    this.walMaintenance = walMaintenance;
  }

  close(): void {
    this.walMaintenance.close();
    this.db.close();
  }

  frameFilePath(day: string, capturedAtMs: number): string {
    return path.join(this.framesDir, day, `${capturedAtMs}.jpg`);
  }

  insertFrame(params: {
    capturedAtMs: number;
    day: string;
    path: string;
    screenIndex: number;
    width?: number;
    height?: number;
    byteSize: number;
    contentHash: string;
    idle: boolean;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO frames (captured_at_ms, day, path, screen_index, width, height, byte_size, content_hash, idle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.capturedAtMs,
        params.day,
        params.path,
        params.screenIndex,
        params.width ?? null,
        params.height ?? null,
        params.byteSize,
        params.contentHash,
        params.idle ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  lastFrame(): { capturedAtMs: number; contentHash: string } | null {
    const row = this.db
      .prepare(
        `SELECT captured_at_ms, content_hash FROM frames ORDER BY captured_at_ms DESC LIMIT 1`,
      )
      .get() as { captured_at_ms: number; content_hash: string } | undefined;
    return row ? { capturedAtMs: row.captured_at_ms, contentHash: row.content_hash } : null;
  }

  unbatchedActiveFrames(limit: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE batch_id IS NULL AND idle = 0
         ORDER BY captured_at_ms ASC LIMIT ?`,
      )
      .all(limit) as FrameRow[];
    return rows.map(toFrame);
  }

  countUnbatchedActiveFrames(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM frames WHERE batch_id IS NULL AND idle = 0`)
      .get() as { n: number };
    return row.n;
  }

  frameById(id: number): LogbookFrame | null {
    const row = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE id = ?`,
      )
      .get(id) as FrameRow | undefined;
    return row ? toFrame(row) : null;
  }

  framesInRange(startMs: number, endMs: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE captured_at_ms >= ? AND captured_at_ms < ?
         ORDER BY captured_at_ms ASC`,
      )
      .all(startMs, endMs) as FrameRow[];
    return rows.map(toFrame);
  }

  createBatch(params: { day: string; startMs: number; endMs: number; frameIds: number[] }): number {
    if (params.frameIds.length === 0) {
      throw new Error("Logbook batch requires at least one frame");
    }
    const now = Date.now();
    const insertBatch = this.db.prepare(
      `INSERT INTO batches (day, start_ms, end_ms, status, frame_count, created_ms, updated_ms)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    );
    const assignFrame = this.db.prepare(
      `UPDATE frames SET batch_id = ? WHERE id = ? AND batch_id IS NULL`,
    );
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const result = insertBatch.run(
          params.day,
          params.startMs,
          params.endMs,
          params.frameIds.length,
          now,
          now,
        );
        const batchId = Number(result.lastInsertRowid);
        for (const frameId of params.frameIds) {
          const assignment = assignFrame.run(batchId, frameId);
          if (assignment.changes !== 1) {
            throw new Error(`Logbook frame ${frameId} is missing or already batched`);
          }
        }
        return batchId;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.batch.create",
      },
    );
  }

  setBatchStatus(
    batchId: number,
    status: LogbookBatchStatus,
    error?: string,
    model?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE batches SET status = ?, error = ?, model = COALESCE(?, model), updated_ms = ? WHERE id = ?`,
      )
      .run(status, error ?? null, model ?? null, Date.now(), batchId);
  }

  latestBatch(): LogbookBatch | null {
    const row = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, status, error, frame_count, model
         FROM batches ORDER BY id DESC LIMIT 1`,
      )
      .get() as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  /** Requeues batches stuck in `running` after a crash so frames are not orphaned. */
  resetRunningBatches(): void {
    this.db
      .prepare(`UPDATE batches SET status = 'pending', updated_ms = ? WHERE status = 'running'`)
      .run(Date.now());
  }

  /** Requeues failed batches for an explicit user-driven retry (analyze now). */
  resetErrorBatches(): number {
    const result = this.db
      .prepare(
        `UPDATE batches SET status = 'pending', error = NULL, updated_ms = ? WHERE status = 'error'`,
      )
      .run(Date.now());
    return Number(result.changes);
  }

  nextPendingBatch(): LogbookBatch | null {
    const row = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, status, error, frame_count, model
         FROM batches WHERE status = 'pending' ORDER BY start_ms ASC LIMIT 1`,
      )
      .get() as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  batchFrames(batchId: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE batch_id = ? ORDER BY captured_at_ms ASC`,
      )
      .all(batchId) as FrameRow[];
    return rows.map(toFrame);
  }

  /**
   * Replaces a batch's observations atomically. Batch retries (analyze now
   * after an error) rerun the vision stage, so appending would duplicate
   * evidence into card synthesis, standups, and ask answers.
   */
  replaceObservations(
    batchId: number,
    day: string,
    segments: Array<{ startMs: number; endMs: number; text: string }>,
  ): void {
    const deleteBatch = this.db.prepare(`DELETE FROM observations WHERE batch_id = ?`);
    const insert = this.db.prepare(
      `INSERT INTO observations (batch_id, day, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)`,
    );
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteBatch.run(batchId);
        for (const segment of segments) {
          insert.run(batchId, day, segment.startMs, segment.endMs, segment.text);
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.replace",
      },
    );
  }

  observationsInRange(day: string, startMs: number, endMs: number): LogbookObservation[] {
    const rows = this.db
      .prepare(
        `SELECT id, batch_id, day, start_ms, end_ms, text FROM observations
         WHERE day = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms ASC`,
      )
      .all(day, startMs, endMs) as Array<{
      id: number;
      batch_id: number;
      day: string;
      start_ms: number;
      end_ms: number;
      text: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      day: row.day,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
    }));
  }

  cardsForDay(day: string): LogbookCard[] {
    const rows = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id
         FROM cards WHERE day = ? ORDER BY start_ms ASC`,
      )
      .all(day) as CardRow[];
    return rows.map(toCard);
  }

  cardById(id: number): LogbookCard | null {
    const row = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id
         FROM cards WHERE id = ?`,
      )
      .get(id) as CardRow | undefined;
    return row ? toCard(row) : null;
  }

  /**
   * Replaces cards overlapping [startMs, endMs) for a day in one transaction.
   * The analysis lookback treats recent cards as a revisable draft, so partial
   * writes here would surface as duplicated or missing timeline segments.
   */
  replaceCardsInWindow(
    day: string,
    startMs: number,
    endMs: number,
    drafts: LogbookCardDraft[],
  ): void {
    const now = Date.now();
    const deleteWindow = this.db.prepare(
      `DELETE FROM cards WHERE day = ? AND end_ms > ? AND start_ms < ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO cards (day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteWindow.run(day, startMs, endMs);
        for (const draft of drafts) {
          insert.run(
            draft.day,
            draft.startMs,
            draft.endMs,
            draft.title,
            draft.summary,
            draft.detail,
            draft.category,
            draft.appPrimary ?? null,
            draft.appSecondary ?? null,
            JSON.stringify(draft.distractions),
            draft.keyframeId ?? null,
            now,
          );
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.cards.replace",
      },
    );
  }

  listDays(): Array<{ day: string; cards: number; firstMs: number; lastMs: number }> {
    const rows = this.db
      .prepare(
        `SELECT day, COUNT(*) AS cards, MIN(start_ms) AS first_ms, MAX(end_ms) AS last_ms
         FROM cards GROUP BY day ORDER BY day DESC`,
      )
      .all() as Array<{ day: string; cards: number; first_ms: number; last_ms: number }>;
    return rows.map((row) => ({
      day: row.day,
      cards: row.cards,
      firstMs: row.first_ms,
      lastMs: row.last_ms,
    }));
  }

  dayStats(day: string): LogbookDayStats {
    const cards = this.cardsForDay(day);
    const categories = new Map<string, number>();
    const apps = new Map<string, number>();
    let trackedMs = 0;
    let distractionMs = 0;
    for (const card of cards) {
      const duration = Math.max(0, card.endMs - card.startMs);
      trackedMs += duration;
      categories.set(card.category, (categories.get(card.category) ?? 0) + duration);
      if (card.appPrimary) {
        apps.set(card.appPrimary, (apps.get(card.appPrimary) ?? 0) + duration);
      }
      for (const distraction of card.distractions) {
        distractionMs += Math.max(0, distraction.endMs - distraction.startMs);
      }
    }
    const byMsDesc = (a: { ms: number }, b: { ms: number }) => b.ms - a.ms;
    return {
      trackedMs,
      distractionMs,
      categories: [...categories.entries()]
        .map(([category, ms]) => ({ category, ms }))
        .toSorted(byMsDesc),
      apps: [...apps.entries()].map(([domain, ms]) => ({ domain, ms })).toSorted(byMsDesc),
    };
  }

  getStandup(day: string): { day: string; text: string; updatedMs: number } | null {
    const row = this.db
      .prepare(`SELECT day, text, updated_ms FROM standups WHERE day = ?`)
      .get(day) as { day: string; text: string; updated_ms: number } | undefined;
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup(day: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO standups (day, text, updated_ms) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET text = excluded.text, updated_ms = excluded.updated_ms`,
      )
      .run(day, text, Date.now());
  }

  /** Deletes frame rows and files older than the retention window. */
  pruneFrames(olderThanMs: number): number {
    const selectExpired = this.db.prepare(
      `SELECT id, path, day FROM frames WHERE captured_at_ms < ?`,
    );
    const rows = selectExpired.all(olderThanMs) as Array<{
      id: number;
      path: string;
      day: string;
    }>;
    if (rows.length === 0) {
      return 0;
    }
    const days = new Set<string>();
    for (const row of rows) {
      // Keep metadata until every file operation succeeds. A later retry can
      // then find rows whose earlier files were already removed with force.
      rmSync(row.path, { force: true });
      days.add(row.day);
    }
    const selectCurrent = this.db.prepare(`SELECT path FROM frames WHERE id = ?`);
    const deleteById = this.db.prepare(`DELETE FROM frames WHERE id = ?`);
    const deleted = runSqliteImmediateTransactionSync(
      this.db,
      () => {
        let count = 0;
        for (const row of rows) {
          const current = selectCurrent.get(row.id) as { path: string } | undefined;
          if (!current) {
            continue;
          }
          if (current.path !== row.path) {
            throw new Error(`Logbook frame ${row.id} changed path while pruning`);
          }
          // keyframe_id uses ON DELETE SET NULL, so the same commit cannot
          // leave surviving cards pointed at removed frame rows.
          count += Number(deleteById.run(row.id).changes);
        }
        return count;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.frames.prune",
      },
    );
    for (const day of days) {
      // Best-effort: removes now-empty day directories, keeps non-empty ones.
      try {
        rmdirSync(path.join(this.framesDir, day));
      } catch {}
    }
    return deleted;
  }
}
