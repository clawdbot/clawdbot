// Validates SQLite delivery queue inflate guards against corrupted entry_json.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  completeDeliveryQueueEntry,
  countFailedDeliveryQueueEntries,
  deleteDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery-queue-sqlite corrupt JSON resilience", () => {
  let stateDir: string;
  let tmpDir: string;
  const QUEUE = "test-q";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-case-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertCorruptRow(id: string, json: string) {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    db.prepare(
      `INSERT INTO delivery_queue_entries
         (queue_name, id, status, entry_kind, session_key, channel, target, account_id,
          retry_count, last_attempt_at, last_error, platform_send_started_at, recovery_state,
          entry_json, enqueued_at, updated_at, failed_at)
       VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(QUEUE, id, json, Date.now(), Date.now());
    db.close();
  }

  function enqueueValid(id: string) {
    upsertDeliveryQueueEntry({
      queueName: QUEUE,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0 },
      stateDir,
    });
  }

  describe("loadDeliveryQueueEntry", () => {
    it("returns null for a row with corrupted entry_json", () => {
      insertCorruptRow("bad-1", "{corrupt: true, >>>NOT JSON<<<");
      expect(loadDeliveryQueueEntry(QUEUE, "bad-1", stateDir)).toBeNull();
    });

    it("returns the entry for valid JSON", () => {
      enqueueValid("good-1");
      const result = loadDeliveryQueueEntry(QUEUE, "good-1", stateDir);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("good-1");
    });

    it("returns null for a nonexistent entry", () => {
      expect(loadDeliveryQueueEntry(QUEUE, "nonexistent", stateDir)).toBeNull();
    });
  });

  describe("loadDeliveryQueueEntries", () => {
    it("skips corrupt rows, returns only valid entries", () => {
      enqueueValid("valid-a");
      insertCorruptRow("bad-x", "{{{broken");
      enqueueValid("valid-b");

      const entries = loadDeliveryQueueEntries(QUEUE, stateDir);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.id).toSorted()).toEqual(["valid-a", "valid-b"]);
    });

    it("returns empty array when all rows are corrupt", () => {
      insertCorruptRow("bad-1", "not json");
      insertCorruptRow("bad-2", "{also broken");

      expect(loadDeliveryQueueEntries(QUEUE, stateDir)).toEqual([]);
    });

    it("returns all entries when all rows are valid", () => {
      enqueueValid("v1");
      enqueueValid("v2");
      enqueueValid("v3");

      expect(loadDeliveryQueueEntries(QUEUE, stateDir)).toHaveLength(3);
    });
  });

  describe("updateDeliveryQueueEntry with corrupt row", () => {
    it("throws ENOENT (unrecoverable corrupt JSON)", () => {
      insertCorruptRow("bad-update", "{corrupt");

      expect(() => updateDeliveryQueueEntry(QUEUE, "bad-update", stateDir, (e) => e)).toThrow(
        /No pending test-q delivery queue entry bad-update/,
      );
    });
  });

  describe("moveDeliveryQueueEntryToFailed with corrupt row", () => {
    it("throws ENOENT (unrecoverable corrupt JSON)", () => {
      insertCorruptRow("bad-move", "{corrupt");

      expect(() => moveDeliveryQueueEntryToFailed(QUEUE, "bad-move", stateDir)).toThrow(
        /No pending test-q delivery queue entry bad-move/,
      );
    });
  });

  describe("valid entry round-trips", () => {
    it("upsert then load is identity", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-1", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      const loaded = loadDeliveryQueueEntry(QUEUE, "rt-1", stateDir);
      expect(loaded).toMatchObject({ id: "rt-1", enqueuedAt: 1000, retryCount: 0 });
    });

    it("update increments retry count", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-2", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      updateDeliveryQueueEntry(QUEUE, "rt-2", stateDir, (entry) => ({
        ...entry,
        retryCount: entry.retryCount + 1,
        lastError: "timeout",
      }));

      expect(loadDeliveryQueueEntry(QUEUE, "rt-2", stateDir)).toMatchObject({
        id: "rt-2",
        retryCount: 1,
        lastError: "timeout",
      });
    });

    it("delete removes the entry", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-3", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      deleteDeliveryQueueEntry(QUEUE, "rt-3", stateDir);
      expect(loadDeliveryQueueEntry(QUEUE, "rt-3", stateDir)).toBeNull();
    });

    it("complete retains an idempotency tombstone outside pending reads", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id: "rt-expired-completed",
          enqueuedAt: Date.now() - 31 * 24 * 60 * 60_000,
          retryCount: 0,
        },
        status: "completed",
        stateDir,
      });
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id: "rt-completed",
          enqueuedAt: 1000,
          retryCount: 3,
          lastError: "must not persist",
        },
        metadata: {
          sessionKey: "agent:main:main",
          channel: "discord",
          target: "channel:123",
          accountId: "default",
        },
        stateDir,
      });

      completeDeliveryQueueEntry(QUEUE, "rt-completed", stateDir);

      expect(loadDeliveryQueueEntry(QUEUE, "rt-completed", stateDir)).toBeNull();
      expect(getDeliveryQueueEntryStatus(QUEUE, "rt-completed", stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(QUEUE, "rt-expired-completed", stateDir)).toBeUndefined();
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const row = db
        .prepare(
          `SELECT entry_json, session_key, channel, target, account_id, retry_count, last_error
             FROM delivery_queue_entries
            WHERE queue_name = ? AND id = ?`,
        )
        .get(QUEUE, "rt-completed") as Record<string, unknown>;
      expect(JSON.parse(String(row.entry_json))).toEqual({
        id: "rt-completed",
        enqueuedAt: expect.any(Number),
        retryCount: 0,
        acknowledgedAt: expect.any(Number),
      });
      expect(row).toMatchObject({
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        retry_count: 0,
        last_error: null,
      });
    });
  });
});

describe("countFailedDeliveryQueueEntries", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-count-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function enqueue(queueName: string, id: string, enqueuedAt: number) {
    upsertDeliveryQueueEntry({
      queueName,
      entry: { id, enqueuedAt, retryCount: 0 },
      stateDir,
    });
  }

  it("returns an empty list when nothing is dead-lettered", () => {
    enqueue("outbound", "pending-1", 1_000);

    expect(countFailedDeliveryQueueEntries(stateDir)).toEqual([]);
  });

  it("counts dead-lettered entries per queue with the oldest failure timestamp", () => {
    enqueue("outbound", "dead-1", 1_000);
    enqueue("outbound", "dead-2", 2_000);
    enqueue("outbound", "still-pending", 3_000);
    enqueue("session", "dead-3", 4_000);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(50_000);
      moveDeliveryQueueEntryToFailed("outbound", "dead-1", stateDir);
      vi.setSystemTime(60_000);
      moveDeliveryQueueEntryToFailed("outbound", "dead-2", stateDir);
      vi.setSystemTime(70_000);
      moveDeliveryQueueEntryToFailed("session", "dead-3", stateDir);
    } finally {
      vi.useRealTimers();
    }

    const counts = countFailedDeliveryQueueEntries(stateDir);

    expect(counts).toHaveLength(2);
    const outbound = counts.find((queue) => queue.queueName === "outbound");
    expect(outbound?.count).toBe(2);
    expect(outbound?.oldestFailedAt).toBe(50_000);
    const session = counts.find((queue) => queue.queueName === "session");
    expect(session?.count).toBe(1);
    expect(session?.oldestFailedAt).toBe(70_000);
    expect(loadDeliveryQueueEntries("outbound", stateDir).map((entry) => entry.id)).toEqual([
      "still-pending",
    ]);
  });
});
