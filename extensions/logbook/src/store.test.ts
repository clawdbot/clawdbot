import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogbookStore, dayKeyFor } from "./store.js";
import type { LogbookCardDraft } from "./types.js";

const DAY = "2026-07-03";

function draft(overrides: Partial<LogbookCardDraft> = {}): LogbookCardDraft {
  const base = new Date(`${DAY}T10:00:00`).getTime();
  return {
    day: DAY,
    startMs: base,
    endMs: base + 30 * 60_000,
    title: "Card",
    summary: "Summary",
    detail: "",
    category: "coding",
    appPrimary: "github.com",
    appSecondary: undefined,
    distractions: [],
    keyframeId: undefined,
    ...overrides,
  };
}

describe("LogbookStore", () => {
  let dir: string;
  let store: LogbookStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "logbook-store-"));
    store = new LogbookStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insertFrame = (capturedAtMs: number, opts?: { idle?: boolean; hash?: string }) => {
    const day = dayKeyFor(capturedAtMs);
    const filePath = store.frameFilePath(day, capturedAtMs);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "jpeg-bytes");
    return store.insertFrame({
      capturedAtMs,
      day,
      path: filePath,
      screenIndex: 0,
      byteSize: 9,
      contentHash: opts?.hash ?? `hash-${capturedAtMs}`,
      idle: opts?.idle ?? false,
    });
  };

  it("tracks unbatched active frames and excludes idle ones", () => {
    const t0 = Date.now();
    insertFrame(t0);
    insertFrame(t0 + 1000, { idle: true });
    insertFrame(t0 + 2000);
    expect(store.countUnbatchedActiveFrames()).toBe(2);
    const batchId = store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 3000,
      frameIds: store.unbatchedActiveFrames(10).map((frame) => frame.id),
    });
    expect(store.countUnbatchedActiveFrames()).toBe(0);
    expect(store.batchFrames(batchId)).toHaveLength(2);
  });

  it("creates every owned table as STRICT with foreign keys enabled", () => {
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"), { readOnly: true });
    try {
      const ordinaryTables = database
        .prepare(
          `SELECT name, strict FROM pragma_table_list
           WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all();
      expect(ordinaryTables).toEqual([
        { name: "batches", strict: 1 },
        { name: "cards", strict: 1 },
        { name: "frames", strict: 1 },
        { name: "observations", strict: 1 },
        { name: "standups", strict: 1 },
      ]);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(database.prepare("PRAGMA foreign_key_list(observations)").all()).toContainEqual(
        expect.objectContaining({ table: "batches", on_delete: "CASCADE" }),
      );
      expect(database.prepare("PRAGMA foreign_key_list(cards)").all()).toContainEqual(
        expect.objectContaining({ table: "frames", on_delete: "SET NULL" }),
      );
    } finally {
      database.close();
    }
  });

  it("rejects values that violate STRICT column types", () => {
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"));
    try {
      expect(() =>
        database
          .prepare("INSERT INTO standups (day, text, updated_ms) VALUES (?, ?, ?)")
          .run(DAY, "bad timestamp", "not-an-integer"),
      ).toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM standups").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("rolls back the whole batch when any frame is missing", () => {
    const t0 = Date.now();
    const frameId = insertFrame(t0);

    expect(() =>
      store.createBatch({
        day: dayKeyFor(t0),
        startMs: t0,
        endMs: t0 + 1000,
        frameIds: [frameId, 999_999],
      }),
    ).toThrow("Logbook frame 999999 is missing or already batched");

    expect(store.latestBatch()).toBeNull();
    expect(store.unbatchedActiveFrames(10).map((frame) => frame.id)).toEqual([frameId]);
  });

  it("does not steal a frame from an existing batch", () => {
    const t0 = Date.now();
    const firstFrame = insertFrame(t0);
    const secondFrame = insertFrame(t0 + 1000);
    const firstBatch = store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [firstFrame],
    });

    expect(() =>
      store.createBatch({
        day: dayKeyFor(t0),
        startMs: t0,
        endMs: t0 + 2000,
        frameIds: [firstFrame, secondFrame],
      }),
    ).toThrow(`Logbook frame ${firstFrame} is missing or already batched`);

    expect(store.latestBatch()?.id).toBe(firstBatch);
    expect(store.batchFrames(firstBatch).map((frame) => frame.id)).toEqual([firstFrame]);
    expect(store.unbatchedActiveFrames(10).map((frame) => frame.id)).toEqual([secondFrame]);
  });

  it("rejects empty and duplicate frame claims without leaving a batch", () => {
    const t0 = Date.now();
    expect(() =>
      store.createBatch({ day: DAY, startMs: t0, endMs: t0 + 1000, frameIds: [] }),
    ).toThrow("Logbook batch requires at least one frame");
    const frameId = insertFrame(t0);
    expect(() =>
      store.createBatch({
        day: DAY,
        startMs: t0,
        endMs: t0 + 1000,
        frameIds: [frameId, frameId],
      }),
    ).toThrow(`Logbook frame ${frameId} is missing or already batched`);
    expect(store.latestBatch()).toBeNull();
    expect(store.countUnbatchedActiveFrames()).toBe(1);
  });

  it("resets running batches to pending on startup recovery", () => {
    const t0 = Date.now();
    insertFrame(t0);
    const batchId = store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [1],
    });
    store.setBatchStatus(batchId, "running");
    store.resetRunningBatches();
    expect(store.nextPendingBatch()?.id).toBe(batchId);
  });

  it("replaces only cards overlapping the revision window", () => {
    const base = new Date(`${DAY}T09:00:00`).getTime();
    store.replaceCardsInWindow(DAY, base, base + 4 * 60 * 60_000, [
      draft({ startMs: base, endMs: base + 30 * 60_000, title: "Early" }),
      draft({ startMs: base + 60 * 60_000, endMs: base + 90 * 60_000, title: "Mid" }),
    ]);
    // Revise only the window covering "Mid"; "Early" must survive untouched.
    store.replaceCardsInWindow(DAY, base + 50 * 60_000, base + 2 * 60 * 60_000, [
      draft({ startMs: base + 55 * 60_000, endMs: base + 95 * 60_000, title: "Mid revised" }),
    ]);
    const titles = store.cardsForDay(DAY).map((card) => card.title);
    expect(titles).toEqual(["Early", "Mid revised"]);
  });

  it("round-trips distractions and computes day stats", () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    store.replaceCardsInWindow(DAY, base, base + 60 * 60_000, [
      draft({
        distractions: [{ startMs: base + 5 * 60_000, endMs: base + 10 * 60_000, title: "Twitter" }],
      }),
    ]);
    const cards = store.cardsForDay(DAY);
    expect(expectDefined(cards[0], "stored logbook card").distractions).toEqual([
      { startMs: base + 5 * 60_000, endMs: base + 10 * 60_000, title: "Twitter" },
    ]);
    const stats = store.dayStats(DAY);
    expect(stats.trackedMs).toBe(30 * 60_000);
    expect(stats.distractionMs).toBe(5 * 60_000);
    expect(stats.categories[0]).toEqual({ category: "coding", ms: 30 * 60_000 });
    expect(expectDefined(stats.apps[0], "logbook app statistic").domain).toBe("github.com");
  });

  it("prunes old frame rows and files but keeps recent ones", () => {
    const now = Date.now();
    const oldId = insertFrame(now - 20 * 24 * 60 * 60_000);
    const newId = insertFrame(now);
    const oldPath = store.frameById(oldId)?.path ?? "";
    expect(store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toBe(1);
    expect(store.frameById(oldId)).toBeNull();
    expect(existsSync(oldPath)).toBe(false);
    expect(store.frameById(newId)).not.toBeNull();
  });

  it("keeps frame metadata when a retained file cannot be removed", () => {
    const now = Date.now();
    const firstId = insertFrame(now - 21 * 24 * 60 * 60_000);
    const blockedId = insertFrame(now - 20 * 24 * 60 * 60_000);
    const blockedPath = expectDefined(store.frameById(blockedId), "blocked frame").path;
    rmSync(blockedPath);
    mkdirSync(blockedPath);

    expect(() => store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toThrow();
    expect(store.frameById(firstId)).not.toBeNull();
    expect(store.frameById(blockedId)).not.toBeNull();

    rmSync(blockedPath, { recursive: true });
    expect(store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toBe(2);
    expect(store.frameById(firstId)).toBeNull();
    expect(store.frameById(blockedId)).toBeNull();
  });

  it("detaches pruned keyframes from surviving cards", () => {
    const now = Date.now();
    const oldId = insertFrame(now - 20 * 24 * 60 * 60_000);
    store.replaceCardsInWindow(DAY, 0, Number.MAX_SAFE_INTEGER, [draft({ keyframeId: oldId })]);
    store.pruneFrames(now - 14 * 24 * 60 * 60_000);
    expect(store.cardsForDay(DAY)[0]?.keyframeId).toBeUndefined();
  });

  it("replaces observations on batch retry instead of appending", () => {
    const t0 = Date.now();
    const frameId = insertFrame(t0);
    const batchId = store.createBatch({
      day: DAY,
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [frameId],
    });
    store.replaceObservations(batchId, DAY, [{ startMs: t0, endMs: t0 + 500, text: "first run" }]);
    store.replaceObservations(batchId, DAY, [{ startMs: t0, endMs: t0 + 500, text: "retry run" }]);
    const observations = store.observationsInRange(DAY, 0, Number.MAX_SAFE_INTEGER);
    expect(observations).toHaveLength(1);
    expect(expectDefined(observations[0], "retried observation").text).toBe("retry run");
  });

  it("rejects observations for a missing batch", () => {
    expect(() =>
      store.replaceObservations(999_999, DAY, [
        { startMs: 1, endMs: 2, text: "orphan observation" },
      ]),
    ).toThrow();
    expect(store.observationsInRange(DAY, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("rolls back a card replacement with a missing keyframe", () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    store.replaceCardsInWindow(DAY, base, base + 60_000, [draft({ title: "kept" })]);

    expect(() =>
      store.replaceCardsInWindow(DAY, base, base + 60_000, [
        draft({ title: "invalid", keyframeId: 999_999 }),
      ]),
    ).toThrow();
    expect(store.cardsForDay(DAY).map((card) => card.title)).toEqual(["kept"]);
  });

  it("requeues errored batches for explicit retry", () => {
    const t0 = Date.now();
    const frameId = insertFrame(t0);
    const batchId = store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [frameId],
    });
    store.setBatchStatus(batchId, "error", "boom");
    expect(store.nextPendingBatch()).toBeNull();
    expect(store.resetErrorBatches()).toBe(1);
    const requeued = store.nextPendingBatch();
    expect(requeued?.id).toBe(batchId);
    expect(requeued?.error).toBeUndefined();
  });

  it("keeps capture data owner-only on disk", () => {
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(store.framesDir)).toBe(0o700);
    expect(mode(path.join(dir, "logbook.sqlite"))).toBe(0o600);
  });

  it("stores and updates standups", () => {
    store.saveStandup(DAY, "## Done\n- shipped");
    store.saveStandup(DAY, "## Done\n- shipped more");
    expect(store.getStandup(DAY)?.text).toContain("shipped more");
  });

  it("migrates legacy tables to STRICT without losing batch assignments", () => {
    store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    rmSync(databasePath, { force: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        frame_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at_ms INTEGER NOT NULL,
        day TEXT NOT NULL,
        path TEXT NOT NULL,
        screen_index INTEGER NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        byte_size INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        idle INTEGER NOT NULL DEFAULT 0,
        batch_id INTEGER
      );
      INSERT INTO batches VALUES (7, '${DAY}', 10, 20, 'pending', NULL, 1, NULL, 10, 10);
      INSERT INTO frames VALUES (11, 10, '${DAY}', '/tmp/frame.jpg', 0, NULL, NULL, 1, 'hash', 0, 7);
    `);
    legacy.close();

    store = new LogbookStore(dir);

    expect(store.batchFrames(7).map((frame) => frame.id)).toEqual([11]);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        migrated
          .prepare(
            `SELECT name, strict FROM pragma_table_list
             WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "batches", strict: 1 },
        { name: "cards", strict: 1 },
        { name: "frames", strict: 1 },
        { name: "observations", strict: 1 },
        { name: "standups", strict: 1 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("rolls back a legacy STRICT migration when stored data has the wrong type", () => {
    const legacyDir = path.join(dir, "invalid-legacy");
    mkdirSync(legacyDir);
    const databasePath = path.join(legacyDir, "logbook.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE standups (day TEXT PRIMARY KEY, text TEXT NOT NULL, updated_ms TEXT NOT NULL);
      INSERT INTO standups VALUES ('${DAY}', 'legacy', 'not-an-integer');
    `);
    legacy.close();

    expect(() => new LogbookStore(legacyDir)).toThrow(
      "Failed migrating SQLite table standups to STRICT",
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved.prepare("SELECT strict FROM pragma_table_list WHERE name = 'standups'").get(),
      ).toEqual({ strict: 0 });
      expect(preserved.prepare("SELECT * FROM standups").get()).toEqual({
        day: DAY,
        text: "legacy",
        updated_ms: "not-an-integer",
      });
    } finally {
      preserved.close();
    }
  });
});
