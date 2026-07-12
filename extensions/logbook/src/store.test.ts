import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
