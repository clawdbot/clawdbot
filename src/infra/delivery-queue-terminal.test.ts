import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  completeDeliveryQueueEntry,
  countFailedDeliveryQueueEntries,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  pruneExpiredDeliveryQueueTombstones,
  terminalizePendingDeliveryQueueEntry,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import type { DeliveryQueueCompletionRetention } from "./delivery-queue-sqlite.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery queue pending terminal transition", () => {
  let rootDir: string;
  let stateDir: string;
  const queueName = "terminal-test";
  const boundedRetention = {
    idPrefix: "terminal-bounded-",
    maxAgeMs: 24 * 60 * 60_000,
    maxEntries: 2,
  } as const;
  const terminalEntryRetention = {
    idPrefix: "terminal-",
    maxAgeMs: 60_000,
    maxEntries: 2,
  } as const;
  const enqueueRetained = (ownerQueue: string, id: string, enqueuedAt: number) =>
    upsertDeliveryQueueEntry({
      queueName: ownerQueue,
      entry: { id, enqueuedAt, retryCount: 0, retainOnFailure: true },
      stateDir,
    });

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-terminal-"));
    stateDir = path.join(rootDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("expires a bounded failed fence during its exact replay lookup", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
      const id = `${boundedRetention.idPrefix}failed-run`;
      const entry = {
        id,
        enqueuedAt: Date.now(),
        retryCount: 1,
        completionRetention: boundedRetention,
        payloads: [{ text: "private" }],
      };
      upsertDeliveryQueueEntry({ queueName, entry, stateDir });
      expect(terminalizePendingDeliveryQueueEntry({ queueName, id, entry, stateDir })).toEqual({
        status: "terminalized",
        retained: true,
      });
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const row = db
        .prepare(
          `SELECT entry_json FROM delivery_queue_entries
            WHERE queue_name = ? AND id = ? AND status = 'failed'`,
        )
        .get(queueName, id) as { entry_json: string };
      expect(JSON.parse(row.entry_json)).toEqual({
        id,
        enqueuedAt: Date.now(),
        retryCount: 1,
        failedAt: Date.now(),
        completionRetention: boundedRetention,
        recoveryState: "completed_bounded",
      });

      vi.setSystemTime(Date.now() + boundedRetention.maxAgeMs - 1);
      expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBe("failed");
      vi.setSystemTime(Date.now() + 2);
      expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBeUndefined();
      expect(
        db
          .prepare("SELECT 1 FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
          .get(queueName, id),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds failed producer fences without pruning siblings or permanent owners", () => {
    vi.useFakeTimers();
    try {
      const producerRetention = { ...boundedRetention, idPrefix: "producer:" };
      const fail = (
        ownerQueue: string,
        id: string,
        completionRetention: DeliveryQueueCompletionRetention,
      ) => {
        const entry = { id, enqueuedAt: Date.now(), retryCount: 0, completionRetention };
        upsertDeliveryQueueEntry({ queueName: ownerQueue, entry, stateDir });
        moveDeliveryQueueEntryToFailed(ownerQueue, id, stateDir);
      };
      const firstId = `${producerRetention.idPrefix}failed-a`;
      const secondId = `${producerRetention.idPrefix}failed-b`;
      const thirdId = `${producerRetention.idPrefix}failed-c`;
      const triggerId = `${producerRetention.idPrefix}completed-d`;
      const siblingRetention = {
        ...producerRetention,
        idPrefix: "producer:child:",
      };
      const siblingId = `${siblingRetention.idPrefix}failed`;
      const permanentId = `${producerRetention.idPrefix}permanent`;
      vi.setSystemTime(1_000);
      fail(queueName, firstId, producerRetention);
      vi.setSystemTime(2_000);
      fail(queueName, secondId, producerRetention);
      vi.setSystemTime(3_000);
      fail(queueName, thirdId, producerRetention);
      expect(getDeliveryQueueEntryStatus(queueName, firstId, stateDir)).toBeUndefined();
      expect(getDeliveryQueueEntryStatus(queueName, secondId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, thirdId, stateDir)).toBe("failed");

      vi.setSystemTime(3_100);
      fail(queueName, siblingId, siblingRetention);
      vi.setSystemTime(3_200);
      fail(queueName, permanentId, "permanent");
      vi.setSystemTime(4_000);
      upsertDeliveryQueueEntry({
        queueName,
        entry: {
          id: triggerId,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: producerRetention,
        },
        stateDir,
      });
      completeDeliveryQueueEntry(queueName, triggerId, stateDir);

      expect(getDeliveryQueueEntryStatus(queueName, secondId, stateDir)).toBeUndefined();
      expect(getDeliveryQueueEntryStatus(queueName, thirdId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, triggerId, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(queueName, siblingId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, permanentId, stateDir)).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups backfilled bounded count limits by producer prefix during exact lookup", () => {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const insert = db.prepare(
      `INSERT INTO delivery_queue_entries (
         queue_name, id, status, retry_count, recovery_state, entry_json,
         enqueued_at, updated_at, failed_at
       ) VALUES (?, ?, 'failed', 0, 'completed_bounded', ?, ?, ?, ?)`,
    );
    const policies = [
      { ...boundedRetention, maxAgeMs: 12 * 60 * 60_000, maxEntries: 1 },
      { ...boundedRetention, maxAgeMs: 24 * 60 * 60_000, maxEntries: 1 },
    ] as const;
    const ids = ["terminal-bounded-old", "terminal-bounded-new"] as const;
    ids.forEach((id, index) => {
      const failedAt = Date.now() + index;
      insert.run(
        queueName,
        id,
        JSON.stringify({
          id,
          enqueuedAt: failedAt,
          retryCount: 0,
          failedAt,
          completionRetention: policies[index],
          recoveryState: "completed_bounded",
        }),
        failedAt,
        failedAt,
        failedAt,
      );
    });
    // A missing-id lookup must stay on the primary-key path and leave the
    // backfilled over-cap group untouched.
    expect(getDeliveryQueueEntryStatus(queueName, "missing", stateDir)).toBeUndefined();
    expect(
      db
        .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
        .all(queueName),
    ).toEqual(ids.toSorted().map((id) => ({ id })));
    expect(getDeliveryQueueEntryStatus(queueName, ids[0], stateDir)).toBeUndefined();
    expect(getDeliveryQueueEntryStatus(queueName, ids[1], stateDir)).toBe("failed");
  });

  it("keeps health reads immutable and expires tombstones during maintenance", () => {
    const retention = { idPrefix: "health:", maxAgeMs: 1_000, maxEntries: 1 } as const;
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const insertFailed = db.prepare(
      `INSERT INTO delivery_queue_entries (
         queue_name, id, status, retry_count, recovery_state, entry_json,
         enqueued_at, updated_at, failed_at
       ) VALUES (?, ?, 'failed', 0, ?, ?, ?, ?, ?)`,
    );
    const insertRetained = (
      id: string,
      failedAt: number,
      completionRetention: "permanent" | typeof retention,
    ) => {
      const recoveryState =
        completionRetention === "permanent" ? "completed_permanent" : "completed_bounded";
      insertFailed.run(
        queueName,
        id,
        recoveryState,
        JSON.stringify({
          id,
          enqueuedAt: failedAt,
          retryCount: 0,
          failedAt,
          completionRetention,
          recoveryState,
        }),
        failedAt,
        failedAt,
        failedAt,
      );
    };
    insertRetained("health:expired", 1_000, retention);
    insertRetained("health:over-cap", 9_000, retention);
    insertRetained("health:newest", 9_500, retention);
    insertRetained("health:permanent", 1_000, "permanent");
    insertFailed.run(
      queueName,
      "health:malformed",
      "completed_bounded",
      "{broken",
      1_000,
      1_000,
      1_000,
    );
    upsertDeliveryQueueEntry({
      queueName,
      entry: {
        id: "health:ordinary-completed",
        enqueuedAt: 10_000 - 31 * 24 * 60 * 60_000,
        retryCount: 0,
      },
      status: "completed",
      stateDir,
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      expect(countFailedDeliveryQueueEntries(stateDir)).toEqual([
        { queueName, count: 5, oldestFailedAt: 1_000 },
      ]);
      expect(
        db
          .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
          .all(queueName),
      ).toEqual([
        { id: "health:expired" },
        { id: "health:malformed" },
        { id: "health:newest" },
        { id: "health:ordinary-completed" },
        { id: "health:over-cap" },
        { id: "health:permanent" },
      ]);

      pruneExpiredDeliveryQueueTombstones(stateDir);
    } finally {
      vi.useRealTimers();
    }
    expect(
      db
        .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
        .all(queueName),
    ).toEqual([
      { id: "health:malformed" },
      { id: "health:newest" },
      { id: "health:over-cap" },
      { id: "health:permanent" },
    ]);
  });

  it("reports no failed queues when retained entries are pending", () => {
    enqueueRetained("outbound", "pending-1", 1_000);
    expect(countFailedDeliveryQueueEntries(stateDir)).toEqual([]);
  });

  it("counts failed rows per queue with their oldest failure", () => {
    enqueueRetained("outbound", "dead-1", 1_000);
    enqueueRetained("outbound", "dead-2", 2_000);
    enqueueRetained("outbound", "still-pending", 3_000);
    enqueueRetained("session", "dead-3", 4_000);
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
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    db.prepare(
      "UPDATE delivery_queue_entries SET failed_at = NULL WHERE queue_name = 'session'",
    ).run();

    const counts = countFailedDeliveryQueueEntries(stateDir);
    expect(counts.find((queue) => queue.queueName === "outbound")).toEqual({
      queueName: "outbound",
      count: 2,
      oldestFailedAt: 50_000,
    });
    expect(counts.find((queue) => queue.queueName === "session")).toEqual({
      queueName: "session",
      count: 1,
    });
    expect(loadDeliveryQueueEntries("outbound", stateDir).map((entry) => entry.id)).toEqual([
      "still-pending",
    ]);
  });

  it.each([
    { label: "ordinary", facts: {}, retained: false, expectedRetention: undefined },
    {
      label: "explicit",
      facts: { retainOnFailure: true as const },
      retained: true,
      expectedRetention: "permanent" as const,
    },
    {
      label: "completion owner before legacy policy",
      facts: {
        completionRetention: terminalEntryRetention,
        failureRetention: "permanent" as const,
      },
      retained: true,
      expectedRetention: terminalEntryRetention,
    },
    {
      label: "permanent completion owner",
      facts: { completionRetention: "permanent" as const },
      retained: true,
      expectedRetention: "permanent" as const,
    },
    {
      label: "bounded legacy failure owner",
      facts: { failureRetention: terminalEntryRetention },
      retained: true,
      expectedRetention: terminalEntryRetention,
    },
    {
      label: "permanent legacy failure owner",
      facts: { failureRetention: "permanent" as const },
      retained: true,
      expectedRetention: "permanent" as const,
    },
    {
      label: "none legacy failure owner",
      facts: { failureRetention: "none" as const },
      retained: false,
      expectedRetention: undefined,
    },
    { label: "producer claim required", facts: { requiresProducerClaim: true }, retained: false },
    {
      label: "durable completion owner",
      facts: { deliveryCompletion: { kind: "conversation", operationId: "op-1" } },
      retained: true,
      expectedRetention: "permanent" as const,
    },
    {
      label: "claimed session",
      ownerQueue: "session",
      facts: { availableAt: 60_000 },
      retained: true,
      expectedRetention: "permanent" as const,
    },
    { label: "active producer claim", facts: { producerClaimId: "claim-1" }, retained: false },
    {
      label: "platform send evidence",
      facts: {
        platformSendAttemptId: "attempt-1",
        platformSendStartedAt: 40_000,
        recoveryState: "unknown_after_send",
      },
      retained: false,
    },
    {
      label: "invalid bounded owner",
      facts: {
        completionRetention: { idPrefix: "other-", maxAgeMs: 60_000, maxEntries: 2 },
      },
      retained: false,
      expectedRetention: undefined,
    },
  ])(
    "removes private state for $label failure",
    ({ label, facts, retained, expectedRetention, ownerQueue = queueName }) => {
      const entry = {
        id: `terminal-${label}`,
        enqueuedAt: 1_000,
        retryCount: 2,
        ...facts,
        sessionKey: "private-session",
        channel: "private-channel",
        to: "private-target",
        accountId: "private-account",
        lastError: "raw provider error",
        payloads: [{ text: "private payload", mediaUrl: "/private/media" }],
      };
      upsertDeliveryQueueEntry({ queueName: ownerQueue, entry, stateDir });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(50_000);
        expect(
          terminalizePendingDeliveryQueueEntry({
            queueName: ownerQueue,
            id: entry.id,
            entry,
            stateDir,
          }),
        ).toEqual({ status: "terminalized", retained });
        expect(getDeliveryQueueEntryStatus(ownerQueue, entry.id, stateDir)).toBe(
          retained ? "failed" : undefined,
        );
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });
        const row = db
          .prepare(
            `SELECT entry_kind, session_key, channel, target, account_id, last_attempt_at,
                    last_error, recovery_state, platform_send_started_at, entry_json,
                    enqueued_at, failed_at
               FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
          )
          .get(ownerQueue, entry.id) as Record<string, unknown> | undefined;
        if (!retained) {
          expect(row).toBeUndefined();
          return;
        }
        const retention = expectedRetention ?? "permanent";
        const recoveryState =
          retention === "permanent" ? "completed_permanent" : "completed_bounded";
        expect(row).toEqual({
          entry_kind: null,
          session_key: null,
          channel: null,
          target: null,
          account_id: null,
          last_attempt_at: null,
          last_error: null,
          recovery_state: recoveryState,
          platform_send_started_at: null,
          entry_json: JSON.stringify({
            id: entry.id,
            enqueuedAt: 50_000,
            retryCount: 2,
            failedAt: 50_000,
            completionRetention: retention,
            recoveryState,
          }),
          enqueued_at: 50_000,
          failed_at: 50_000,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not terminalize a replacement pending owner", () => {
    const entry = { id: "terminal-race", enqueuedAt: 1_000, retryCount: 0 };
    upsertDeliveryQueueEntry({ queueName, entry, stateDir });
    updateDeliveryQueueEntry(queueName, entry.id, stateDir, (current) => ({
      ...current,
      retryCount: 1,
    }));
    expect(
      terminalizePendingDeliveryQueueEntry({ queueName, id: entry.id, entry, stateDir }),
    ).toEqual({ status: "not_pending" });
    expect(loadDeliveryQueueEntry(queueName, entry.id, stateDir)?.retryCount).toBe(1);
  });
});
