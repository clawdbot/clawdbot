// Logbook SQLite store: frames on disk, everything else in one plugin-owned DB.
import { chmodSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
  type Selectable,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookDatabase,
  LogbookDayStats,
  LogbookDistraction,
  LogbookFrame,
  LogbookObservation,
} from "./types.js";

type Database = import("node:sqlite").DatabaseSync;

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
CREATE INDEX IF NOT EXISTS idx_logbook_frames_captured_at ON frames (captured_at_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_frames_unbatched ON frames (batch_id) WHERE batch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_logbook_frames_batch ON frames (batch_id, captured_at_ms) WHERE batch_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_logbook_observations_day ON observations (day, start_ms);
CREATE INDEX IF NOT EXISTS idx_logbook_observations_batch ON observations (batch_id);
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
CREATE INDEX IF NOT EXISTS idx_logbook_cards_keyframe ON cards (keyframe_id) WHERE keyframe_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS standups (
  day TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) STRICT;
`;

type FrameRow = Omit<Selectable<LogbookDatabase["frames"]>, "content_hash" | "batch_id">;
type BatchRow = Omit<Selectable<LogbookDatabase["batches"]>, "created_ms" | "updated_ms">;

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

function toCard(row: Selectable<LogbookDatabase["cards"]>): LogbookCard {
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
  private readonly query;
  private readonly framesQuery;
  private readonly batchesQuery;
  private readonly cardsQuery;
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
    const dbPath = path.join(dataDir, "logbook.sqlite");
    const db = openNodeSqliteDatabase(dbPath);
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
    this.query = getNodeSqliteKysely<LogbookDatabase>(db);
    // Timestamp ties follow insertion ids, matching existing SQLite reads.
    this.framesQuery = this.query
      .selectFrom("frames")
      .select([
        "id",
        "captured_at_ms",
        "day",
        "path",
        "screen_index",
        "width",
        "height",
        "byte_size",
        "idle",
      ])
      .orderBy("captured_at_ms", "asc")
      .orderBy("id", "asc");
    this.batchesQuery = this.query
      .selectFrom("batches")
      .select(["id", "day", "start_ms", "end_ms", "status", "error", "frame_count", "model"]);
    this.cardsQuery = this.query.selectFrom("cards");
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
    const { compiled, bind } = compileSqliteQueryBindings<typeof params>((p) =>
      this.query.insertInto("frames").values({
        captured_at_ms: p((row) => row.capturedAtMs),
        day: p((row) => row.day),
        path: p((row) => row.path),
        screen_index: p((row) => row.screenIndex),
        width: p((row) => row.width ?? null),
        height: p((row) => row.height ?? null),
        byte_size: p((row) => row.byteSize),
        content_hash: p((row) => row.contentHash),
        idle: p((row) => (row.idle ? 1 : 0)),
      }),
    );
    const result = this.db.prepare(compiled.sql).run(...bind(params));
    return Number(result.lastInsertRowid);
  }

  lastFrame(): { capturedAtMs: number; contentHash: string } | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select(["captured_at_ms", "content_hash"])
        .orderBy("captured_at_ms", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    return row ? { capturedAtMs: row.captured_at_ms, contentHash: row.content_hash } : null;
  }

  unbatchedActiveFrames(limit: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "is", null).where("idle", "=", 0).limit(limit),
    ).rows.map(toFrame);
  }

  countUnbatchedActiveFrames(): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("batch_id", "is", null)
        .where("idle", "=", 0),
    );
    return expectDefined(row, "Logbook unbatched frame count").n;
  }

  frameById(id: number): LogbookFrame | null {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.framesQuery.where("id", "=", id));
    return row ? toFrame(row) : null;
  }

  framesInRange(startMs: number, endMs: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("captured_at_ms", ">=", startMs).where("captured_at_ms", "<", endMs),
    ).rows.map(toFrame);
  }

  createBatch(params: { day: string; startMs: number; endMs: number; frameIds: number[] }): number {
    if (params.frameIds.length === 0) {
      throw new Error("Logbook batch requires at least one frame");
    }
    const now = Date.now();
    const batch = compileSqliteQueryBindings<typeof params>((p) =>
      this.query.insertInto("batches").values({
        day: p((row) => row.day),
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        status: "pending",
        frame_count: p((row) => row.frameIds.length),
        created_ms: now,
        updated_ms: now,
      }),
    );
    const insertBatch = this.db.prepare(batch.compiled.sql);
    const assignment = compileSqliteQueryBindings<{ batchId: number; frameId: number }>((p) =>
      this.query
        .updateTable("frames")
        .set({ batch_id: p((row) => row.batchId) })
        .where(
          "id",
          "=",
          p((row) => row.frameId),
        )
        .where("batch_id", "is", null),
    );
    const assignFrame = this.db.prepare(assignment.compiled.sql);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const result = insertBatch.run(...batch.bind(params));
        const batchId = Number(result.lastInsertRowid);
        for (const frameId of params.frameIds) {
          const assigned = assignFrame.run(...assignment.bind({ batchId, frameId }));
          if (assigned.changes !== 1) {
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
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      this.query
        .updateTable("batches")
        .set((eb) => ({
          status,
          error: error ?? null,
          model: eb.fn.coalesce(eb.val(model ?? null), "model"),
          updated_ms: p(() => Date.now()),
        }))
        .where("id", "=", batchId),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  latestBatch(): LogbookBatch | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.batchesQuery.orderBy("id", "desc").limit(1),
    );
    return row ? toBatch(row) : null;
  }

  /** Requeues batches stuck in `running` after a crash so frames are not orphaned. */
  resetRunningBatches(): void {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      this.query
        .updateTable("batches")
        .set({ status: "pending", updated_ms: p(() => Date.now()) })
        .where("status", "=", "running"),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  /** Requeues failed batches for an explicit user-driven retry (analyze now). */
  resetErrorBatches(): number {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      this.query
        .updateTable("batches")
        .set({ status: "pending", error: null, updated_ms: p(() => Date.now()) })
        .where("status", "=", "error"),
    );
    const result = this.db.prepare(compiled.sql).run(...bind());
    return Number(result.changes);
  }

  nextPendingBatch(): LogbookBatch | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.batchesQuery
        .where("status", "=", "pending")
        .orderBy("start_ms", "asc")
        .orderBy("id", "asc")
        .limit(1),
    );
    return row ? toBatch(row) : null;
  }

  batchFrames(batchId: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "=", batchId),
    ).rows.map(toFrame);
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
    const deletion = compileSqliteQueryBindings<void>(() =>
      this.query.deleteFrom("observations").where("batch_id", "=", batchId),
    );
    const deleteBatch = this.db.prepare(deletion.compiled.sql);
    const observation = compileSqliteQueryBindings<(typeof segments)[number]>((p) =>
      this.query.insertInto("observations").values({
        batch_id: batchId,
        day,
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        text: p((row) => row.text),
      }),
    );
    const insert = this.db.prepare(observation.compiled.sql);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteBatch.run(...deletion.bind());
        for (const segment of segments) {
          insert.run(...observation.bind(segment));
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.replace",
      },
    );
  }

  observationsInRange(
    day: string,
    startMs: number,
    endMs: number,
    tailLimit?: number,
  ): LogbookObservation[] {
    const direction = tailLimit === undefined ? "asc" : "desc";
    let query = this.query
      .selectFrom("observations")
      .selectAll()
      .where("day", "=", day)
      .where("end_ms", ">", startMs)
      .where("start_ms", "<", endMs)
      .orderBy("start_ms", direction)
      .orderBy("id", direction);
    if (tailLimit !== undefined) {
      query = query.limit(tailLimit);
    }
    const rows = executeSqliteQuerySync(this.db, query).rows;
    // Reverse the stable timestamp/id tail so prompts keep their original chronology.
    if (tailLimit !== undefined) {
      rows.reverse();
    }
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      day: row.day,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
    }));
  }

  cardsForDay(day: string, window?: { startMs: number; endMs: number }): LogbookCard[] {
    let query = this.cardsQuery
      .selectAll()
      .where("day", "=", day)
      .orderBy("start_ms", "asc")
      .orderBy("id", "asc");
    if (window) {
      query = query.where("end_ms", ">", window.startMs).where("start_ms", "<", window.endMs);
    }
    return executeSqliteQuerySync(this.db, query).rows.map(toCard);
  }

  countCardsForDay(day: string): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.cardsQuery.select((eb) => eb.fn.countAll<number>().as("count")).where("day", "=", day),
    );
    return expectDefined(row, "Logbook card count").count;
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
    const deletion = compileSqliteQueryBindings<void>(() =>
      this.query
        .deleteFrom("cards")
        .where("day", "=", day)
        .where("end_ms", ">", startMs)
        .where("start_ms", "<", endMs),
    );
    const deleteWindow = this.db.prepare(deletion.compiled.sql);
    const card = compileSqliteQueryBindings<LogbookCardDraft>((p) =>
      this.query.insertInto("cards").values({
        day: p((row) => row.day),
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        title: p((row) => row.title),
        summary: p((row) => row.summary),
        detail: p((row) => row.detail),
        category: p((row) => row.category),
        app_primary: p((row) => row.appPrimary ?? null),
        app_secondary: p((row) => row.appSecondary ?? null),
        distractions: p((row) => JSON.stringify(row.distractions)),
        keyframe_id: p((row) => row.keyframeId ?? null),
        updated_ms: now,
      }),
    );
    const insert = this.db.prepare(card.compiled.sql);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteWindow.run(...deletion.bind());
        for (const draft of drafts) {
          insert.run(...card.bind(draft));
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
    return executeSqliteQuerySync(
      this.db,
      this.cardsQuery
        .select((eb) => [
          "day",
          eb.fn.countAll<number>().as("cards"),
          eb.fn.min<number>("start_ms").as("first_ms"),
          eb.fn.max<number>("end_ms").as("last_ms"),
        ])
        .groupBy("day")
        .orderBy("day", "desc"),
    ).rows.map((row) => ({
      day: row.day,
      cards: row.cards,
      firstMs: row.first_ms,
      lastMs: row.last_ms,
    }));
  }

  timelineForDay(day: string): { day: string; cards: LogbookCard[]; stats: LogbookDayStats } {
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
      day,
      cards,
      stats: {
        trackedMs,
        distractionMs,
        categories: [...categories.entries()]
          .map(([category, ms]) => ({ category, ms }))
          .toSorted(byMsDesc),
        apps: [...apps.entries()].map(([domain, ms]) => ({ domain, ms })).toSorted(byMsDesc),
      },
    };
  }

  getStandup(day: string): { day: string; text: string; updatedMs: number } | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("standups").selectAll().where("day", "=", day),
    );
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup(day: string, text: string): void {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      this.query
        .insertInto("standups")
        .values({ day, text, updated_ms: p(() => Date.now()) })
        .onConflict((conflict) =>
          conflict.column("day").doUpdateSet((eb) => ({
            text: eb.ref("excluded.text"),
            updated_ms: eb.ref("excluded.updated_ms"),
          })),
        ),
    );
    this.db.prepare(compiled.sql).run(...bind());
  }

  /** Deletes frame rows and files older than the retention window. */
  pruneFrames(olderThanMs: number): number {
    const rows = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("frames")
        .select(["id", "path", "day"])
        .where("captured_at_ms", "<", olderThanMs),
    ).rows;
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
    const currentPath = compileSqliteQueryBindings<number>((p) =>
      this.query
        .selectFrom("frames")
        .select("path")
        .where(
          "id",
          "=",
          p((id) => id),
        ),
    );
    const selectCurrent = this.db.prepare(currentPath.compiled.sql);
    const deletion = compileSqliteQueryBindings<number>((p) =>
      this.query.deleteFrom("frames").where(
        "id",
        "=",
        p((id) => id),
      ),
    );
    const deleteById = this.db.prepare(deletion.compiled.sql);
    const deleted = runSqliteImmediateTransactionSync(
      this.db,
      () => {
        let count = 0;
        for (const row of rows) {
          const current = selectCurrent.get(...currentPath.bind(row.id));
          if (!current) {
            continue;
          }
          if (current.path !== row.path) {
            throw new Error(`Logbook frame ${row.id} changed path while pruning`);
          }
          // keyframe_id uses ON DELETE SET NULL, so the same commit cannot
          // leave surviving cards pointed at removed frame rows.
          count += Number(deleteById.run(...deletion.bind(row.id)).changes);
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
