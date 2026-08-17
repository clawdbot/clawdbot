// Validates SQLite delivery queue inflate guards against corrupted entry_json.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  claimDeliveryQueueEntryPlatformSend,
  promoteDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
} from "./delivery-queue-sqlite-claim.js";
import { commitStagedDeliveryQueueEntryOnceAcrossNamespaces } from "./delivery-queue-sqlite-namespace.js";
import {
  completeDeliveryQueueEntry,
  countFailedDeliveryQueueEntries,
  deleteDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  pruneExpiredDeliveryQueueTombstones,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery-queue-sqlite corrupt JSON resilience", () => {
  let stateDir: string;
  let tmpDir: string;
  const QUEUE = "test-q";
  const boundedCronRetention = {
    idPrefix: "cron-direct-delivery:v1:",
    maxAgeMs: 24 * 60 * 60_000,
    maxEntries: 2,
  } as const;

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

    it.each([
      {
        name: "outbound delivery",
        queueName: "outbound",
        entry: {
          id: "metadata-outbound",
          channel: "discord",
          to: "channel:123",
          accountId: "bot-a",
          session: { key: "agent:main:discord:channel:123" },
        },
        expected: {
          entry_kind: "outbound",
          session_key: "agent:main:discord:channel:123",
          channel: "discord",
          target: "channel:123",
          account_id: "bot-a",
        },
      },
      {
        name: "routed session delivery",
        queueName: "session",
        entry: {
          id: "metadata-session-route",
          kind: "agentTurn",
          sessionKey: "agent:main:discord:channel:123",
          route: { channel: "discord", to: "channel:123", accountId: "bot-a" },
          deliveryContext: { channel: "telegram", to: "999", accountId: "bot-b" },
        },
        expected: {
          entry_kind: "agentTurn",
          session_key: "agent:main:discord:channel:123",
          channel: "discord",
          target: "channel:123",
          account_id: "bot-a",
        },
      },
      {
        name: "context-only session delivery",
        queueName: "session",
        entry: {
          id: "metadata-session-context",
          kind: "systemEvent",
          sessionKey: "agent:main:telegram:direct:123",
          deliveryContext: { channel: "telegram", to: "123", accountId: "bot-a" },
        },
        expected: {
          entry_kind: "systemEvent",
          session_key: "agent:main:telegram:direct:123",
          channel: "telegram",
          target: "123",
          account_id: "bot-a",
        },
      },
    ])("indexes canonical $name metadata", ({ queueName, entry, expected }) => {
      upsertDeliveryQueueEntry({
        queueName,
        entry: { ...entry, enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const readMetadata = () =>
        db
          .prepare(
            `SELECT entry_kind, session_key, channel, target, account_id
             FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
          )
          .get(queueName, entry.id);
      expect(readMetadata()).toEqual(expected);

      updateDeliveryQueueEntry(queueName, entry.id, stateDir, (current) => ({
        ...current,
        retryCount: current.retryCount + 1,
      }));
      expect(readMetadata()).toEqual(expected);
    });

    it("preserves explicit queue metadata ownership", () => {
      upsertDeliveryQueueEntry({
        queueName: "outbound-media-staging",
        entry: { id: "metadata-media-stage", enqueuedAt: 1000, retryCount: 0 },
        metadata: { entryKind: "outbound-media-stage" },
        stateDir,
      });

      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      expect(
        db
          .prepare("SELECT entry_kind FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
          .get("outbound-media-staging", "metadata-media-stage"),
      ).toEqual({ entry_kind: "outbound-media-stage" });
    });

    it.each([
      { name: "ordinary", conflictQueueNames: [] },
      { name: "cross-namespace", conflictQueueNames: ["outbound-legacy"] },
    ])("indexes $name staged outbound commits", ({ conflictQueueNames }) => {
      const stagingQueueName = "outbound-media-staging";
      const stagingId = "metadata-staged-media";
      const outboundEntry = {
        id: "metadata-staged-outbound",
        enqueuedAt: 1000,
        retryCount: 0,
        channel: "discord",
        to: "channel:123",
        accountId: "bot-a",
        session: { key: "agent:main:discord:channel:123" },
      };
      upsertDeliveryQueueEntry({
        queueName: stagingQueueName,
        entry: { id: stagingId, enqueuedAt: 1000, retryCount: 0 },
        metadata: { entryKind: "outbound-media-stage" },
        stateDir,
      });

      expect(
        commitStagedDeliveryQueueEntryOnceAcrossNamespaces({
          queueName: "outbound",
          entry: outboundEntry,
          stagingId,
          stagingQueueName,
          conflictQueueNames,
          stateDir,
        }),
      ).toBe("created");

      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      expect(
        db
          .prepare(
            `SELECT entry_kind, session_key, channel, target, account_id
             FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
          )
          .get("outbound", "metadata-staged-outbound"),
      ).toEqual({
        entry_kind: "outbound",
        session_key: "agent:main:discord:channel:123",
        channel: "discord",
        target: "channel:123",
        account_id: "bot-a",
      });
      expect(loadDeliveryQueueEntry(stagingQueueName, stagingId, stateDir)).toBeNull();
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
      expect(getDeliveryQueueEntryStatus(QUEUE, "rt-expired-completed", stateDir)).toBe(
        "completed",
      );
      countFailedDeliveryQueueEntries(stateDir);
      expect(getDeliveryQueueEntryStatus(QUEUE, "rt-expired-completed", stateDir)).toBe(
        "completed",
      );
      pruneExpiredDeliveryQueueTombstones(stateDir);
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

    it("bounds cron completion receipts without pruning pending or other owners", () => {
      const completeBounded = (suffix: string, queueName = QUEUE) => {
        const id = `${boundedCronRetention.idPrefix}${suffix}`;
        upsertDeliveryQueueEntry({
          queueName,
          entry: {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: boundedCronRetention,
          },
          stateDir,
        });
        completeDeliveryQueueEntry(queueName, id, stateDir);
        return id;
      };
      const permanentId = `${boundedCronRetention.idPrefix}permanent-owner`;
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id: permanentId,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: "permanent",
        },
        stateDir,
      });
      completeDeliveryQueueEntry(QUEUE, permanentId, stateDir);

      const pendingId = `${boundedCronRetention.idPrefix}pending-owner`;
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id: pendingId,
          enqueuedAt: Date.now(),
          retryCount: 0,
          recoveryState: "send_attempt_started",
          platformSendStartedAt: Date.now(),
        },
        stateDir,
      });
      const unboundedId = `${boundedCronRetention.idPrefix}ordinary-owner`;
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: unboundedId, enqueuedAt: Date.now(), retryCount: 0 },
        stateDir,
      });
      completeDeliveryQueueEntry(QUEUE, unboundedId, stateDir);
      const siblingId = completeBounded("sibling-queue", "session-q");
      const first = completeBounded("a");
      const second = completeBounded("b");
      const third = completeBounded("c");

      expect(getDeliveryQueueEntryStatus(QUEUE, first, stateDir)).toBeUndefined();
      expect(getDeliveryQueueEntryStatus(QUEUE, second, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(QUEUE, third, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(QUEUE, permanentId, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(QUEUE, unboundedId, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(QUEUE, pendingId, stateDir)).toBe("pending");
      expect(getDeliveryQueueEntryStatus("session-q", siblingId, stateDir)).toBe("completed");
    });

    it("expires only the bounded producer namespace after its replay window", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const expiredId = `${boundedCronRetention.idPrefix}expired-run`;
        const otherOwnerId = "another-producer:v1:retained-run";
        for (const id of [expiredId, otherOwnerId]) {
          upsertDeliveryQueueEntry({
            queueName: QUEUE,
            entry: {
              id,
              enqueuedAt: Date.now(),
              retryCount: 0,
              ...(id === expiredId ? { completionRetention: boundedCronRetention } : {}),
            },
            stateDir,
          });
          completeDeliveryQueueEntry(QUEUE, id, stateDir);
        }

        vi.setSystemTime(Date.now() + boundedCronRetention.maxAgeMs + 1);
        const currentId = `${boundedCronRetention.idPrefix}current-run`;
        upsertDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id: currentId,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: boundedCronRetention,
          },
          stateDir,
        });
        completeDeliveryQueueEntry(QUEUE, currentId, stateDir);

        expect(getDeliveryQueueEntryStatus(QUEUE, expiredId, stateDir)).toBeUndefined();
        expect(getDeliveryQueueEntryStatus(QUEUE, currentId, stateDir)).toBe("completed");
        expect(getDeliveryQueueEntryStatus(QUEUE, otherOwnerId, stateDir)).toBe("completed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("expires a lone bounded receipt during its own indexed replay lookup", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const id = `${boundedCronRetention.idPrefix}only-run`;
        upsertDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: boundedCronRetention,
          },
          stateDir,
        });
        completeDeliveryQueueEntry(QUEUE, id, stateDir);

        vi.setSystemTime(Date.now() + boundedCronRetention.maxAgeMs - 1);
        expect(getDeliveryQueueEntryStatus(QUEUE, id, stateDir)).toBe("completed");
        vi.setSystemTime(Date.now() + 2);
        expect(getDeliveryQueueEntryStatus(QUEUE, id, stateDir)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves a bounded receipt beyond the ordinary thirty-day cleanup window", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const id = "long-producer:v1:retained-run";
        upsertDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: {
              idPrefix: "long-producer:v1:",
              maxAgeMs: 60 * 24 * 60 * 60_000,
              maxEntries: 2,
            },
          },
          stateDir,
        });
        completeDeliveryQueueEntry(QUEUE, id, stateDir);

        vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60_000);
        enqueueValid("ordinary-thirty-day-prune-trigger");
        completeDeliveryQueueEntry(QUEUE, "ordinary-thirty-day-prune-trigger", stateDir);

        expect(getDeliveryQueueEntryStatus(QUEUE, id, stateDir)).toBe("completed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects invalid bounded completion ownership before acknowledging a send", () => {
      const id = "another-producer:v1:pending";
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: boundedCronRetention,
        },
        stateDir,
      });

      expect(() => completeDeliveryQueueEntry(QUEUE, id, stateDir)).toThrow(
        "Invalid bounded delivery completion retention",
      );
      expect(getDeliveryQueueEntryStatus(QUEUE, id, stateDir)).toBe("pending");
    });

    it("atomically reserves one pristine pending platform send across queue owners", () => {
      const id = `${boundedCronRetention.idPrefix}cross-process-claim`;
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: boundedCronRetention,
        },
        stateDir,
      });

      const claimId = claimDeliveryQueueEntryPlatformSend({ queueName: QUEUE, id, stateDir });
      expect(claimId).toEqual(expect.any(String));
      expect(
        claimDeliveryQueueEntryPlatformSend({ queueName: QUEUE, id, stateDir }),
      ).toBeUndefined();
      expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
        id,
        recoveryState: "producer_claimed",
        availableAt: expect.any(Number),
        producerClaimId: claimId,
      });
      expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)?.platformSendStartedAt).toBeUndefined();
    });

    it("atomically upgrades a legacy live reuse claim to renewable ownership", () => {
      const id = `${boundedCronRetention.idPrefix}upgrade-reusable-claim`;
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: boundedCronRetention,
        },
        stateDir,
      });

      const claimId = claimDeliveryQueueEntryPlatformSend({
        queueName: QUEUE,
        id,
        stateDir,
        requiresProducerClaim: true,
      });

      expect(claimId).toEqual(expect.any(String));
      expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId: claimId,
        requiresProducerClaim: true,
        availableAt: expect.any(Number),
      });
    });

    it("recovers an expired pre-provider producer lease without claiming platform delivery", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const id = `${boundedCronRetention.idPrefix}expired-producer-claim`;
        upsertDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: boundedCronRetention,
          },
          stateDir,
        });

        const staleClaimId = claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
        });
        expect(staleClaimId).toEqual(expect.any(String));
        vi.setSystemTime(Date.now() + 30_001);
        if (!staleClaimId) {
          throw new Error("test invariant: the original producer claim must be available");
        }
        expect(
          promoteDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            claimId: staleClaimId,
            stateDir,
          }),
        ).toBe(false);
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)?.platformSendStartedAt).toBeUndefined();
        const recoveredClaimId = claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
        });
        if (!recoveredClaimId) {
          throw new Error("test invariant: the recovered producer claim must be available");
        }
        expect(recoveredClaimId).toEqual(expect.any(String));
        expect(recoveredClaimId).not.toBe(staleClaimId);
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
          recoveryState: "producer_claimed",
          availableAt: Date.now() + 30_000,
          producerClaimId: recoveredClaimId,
        });
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)?.platformSendStartedAt).toBeUndefined();
        expect(
          promoteDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            claimId: staleClaimId,
            stateDir,
          }),
        ).toBe(false);
        expect(
          promoteDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            claimId: recoveredClaimId,
            stateDir,
          }),
        ).toBe(true);
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
          recoveryState: "send_attempt_started",
          platformSendStartedAt: expect.any(Number),
        });
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)?.producerClaimId).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["producer_claimed", "send_attempt_started", "unknown_after_send"] as const)(
      "renews the exact unexpired explicit owner in %s",
      (recoveryState) => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
          const id = `${boundedCronRetention.idPrefix}renew-${recoveryState}`;
          const claimId = `claim-${recoveryState}`;
          upsertDeliveryQueueEntry({
            queueName: QUEUE,
            entry: {
              id,
              enqueuedAt: Date.now(),
              retryCount: 0,
              requiresProducerClaim: true,
              availableAt: Date.now() + 5_000,
              ...(recoveryState === "producer_claimed"
                ? { producerClaimId: claimId }
                : {
                    platformSendAttemptId: claimId,
                    platformSendStartedAt: Date.now(),
                  }),
              recoveryState,
            },
            stateDir,
          });
          vi.setSystemTime(Date.now() + 1_000);

          expect(
            renewDeliveryQueueEntryPlatformSendLease({
              queueName: QUEUE,
              id,
              claimId,
              stateDir,
            }),
          ).toBe(Date.now() + 30_000);
          expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
            recoveryState,
            availableAt: Date.now() + 30_000,
            ...(recoveryState === "producer_claimed"
              ? { producerClaimId: claimId }
              : { platformSendAttemptId: claimId }),
          });
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("refuses to renew expired, mismatched, and non-explicit owners", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
        const cases = [
          {
            id: `${boundedCronRetention.idPrefix}renew-expired`,
            requiresProducerClaim: true,
            producerClaimId: "expired-owner",
            availableAt: Date.now(),
            claimId: "expired-owner",
          },
          {
            id: `${boundedCronRetention.idPrefix}renew-wrong-owner`,
            requiresProducerClaim: true,
            producerClaimId: "current-owner",
            availableAt: Date.now() + 5_000,
            claimId: "stale-owner",
          },
          {
            id: `${boundedCronRetention.idPrefix}renew-legacy-owner`,
            requiresProducerClaim: false,
            producerClaimId: "legacy-owner",
            availableAt: Date.now() + 5_000,
            claimId: "legacy-owner",
          },
        ] as const;
        for (const entry of cases) {
          upsertDeliveryQueueEntry({
            queueName: QUEUE,
            entry: {
              id: entry.id,
              enqueuedAt: Date.now(),
              retryCount: 0,
              ...(entry.requiresProducerClaim
                ? { requiresProducerClaim: entry.requiresProducerClaim }
                : {}),
              producerClaimId: entry.producerClaimId,
              availableAt: entry.availableAt,
              recoveryState: "producer_claimed",
            },
            stateDir,
          });

          expect(
            renewDeliveryQueueEntryPlatformSendLease({
              queueName: QUEUE,
              id: entry.id,
              claimId: entry.claimId,
              stateDir,
            }),
          ).toBeUndefined();
          expect(loadDeliveryQueueEntry(QUEUE, entry.id, stateDir)?.availableAt).toBe(
            entry.availableAt,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("fences a reconciled not-sent retry to its exact platform attempt generation", () => {
      const id = `${boundedCronRetention.idPrefix}reconciled-attempt`;
      const platformSendAttemptId = "original-reconciled-attempt";
      const platformSendStartedAt = Date.now();
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id,
          enqueuedAt: platformSendStartedAt,
          retryCount: 0,
          completionRetention: boundedCronRetention,
          platformSendAttemptId,
          platformSendStartedAt,
          recoveryState: "send_attempt_started",
        },
        stateDir,
      });

      expect(
        claimDeliveryQueueEntryPlatformSend({ queueName: QUEUE, id, stateDir }),
      ).toBeUndefined();
      expect(
        claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
          reconciledPlatformSendAttemptId: platformSendAttemptId,
          reconciledPlatformSendStartedAt: platformSendStartedAt - 1,
        }),
      ).toBeUndefined();

      const claimId = claimDeliveryQueueEntryPlatformSend({
        queueName: QUEUE,
        id,
        stateDir,
        reconciledPlatformSendAttemptId: platformSendAttemptId,
        reconciledPlatformSendStartedAt: platformSendStartedAt,
      });
      expect(claimId).toEqual(expect.any(String));
      expect(
        claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
          reconciledPlatformSendAttemptId: platformSendAttemptId,
          reconciledPlatformSendStartedAt: platformSendStartedAt,
        }),
      ).toBeUndefined();
      expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
        recoveryState: "producer_claimed",
        producerClaimId: claimId,
      });
      expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)?.platformSendStartedAt).toBeUndefined();
    });

    it("rejects stale reconciliation when two platform attempts start in the same millisecond", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const id = `${boundedCronRetention.idPrefix}same-millisecond-attempt-fence`;
        upsertDeliveryQueueEntry({
          queueName: QUEUE,
          entry: {
            id,
            enqueuedAt: Date.now(),
            retryCount: 0,
            completionRetention: boundedCronRetention,
          },
          stateDir,
        });

        const firstAttemptId = claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
        });
        if (!firstAttemptId) {
          throw new Error("test invariant: the original platform attempt must be claimed");
        }
        expect(
          promoteDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            claimId: firstAttemptId,
            stateDir,
          }),
        ).toBe(true);
        const firstStartedAt = Date.now();
        const secondAttemptId = claimDeliveryQueueEntryPlatformSend({
          queueName: QUEUE,
          id,
          stateDir,
          reconciledPlatformSendAttemptId: firstAttemptId,
          reconciledPlatformSendStartedAt: firstStartedAt,
        });
        if (!secondAttemptId) {
          throw new Error("test invariant: the reconciled platform attempt must be claimed");
        }
        expect(secondAttemptId).not.toBe(firstAttemptId);
        expect(
          promoteDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            claimId: secondAttemptId,
            stateDir,
          }),
        ).toBe(true);
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
          recoveryState: "send_attempt_started",
          platformSendAttemptId: secondAttemptId,
          platformSendStartedAt: firstStartedAt,
        });

        // A late proof for A must not reclaim live attempt B merely because
        // both provider boundaries observed the same clock millisecond.
        expect(
          claimDeliveryQueueEntryPlatformSend({
            queueName: QUEUE,
            id,
            stateDir,
            reconciledPlatformSendAttemptId: firstAttemptId,
            reconciledPlatformSendStartedAt: firstStartedAt,
          }),
        ).toBeUndefined();
        expect(loadDeliveryQueueEntry(QUEUE, id, stateDir)).toMatchObject({
          recoveryState: "send_attempt_started",
          platformSendAttemptId: secondAttemptId,
          platformSendStartedAt: firstStartedAt,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never prunes a permanent producer receipt", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: {
          id: "rt-permanent",
          enqueuedAt: 1,
          retryCount: 0,
          completionRetention: "permanent",
        },
        stateDir,
      });
      completeDeliveryQueueEntry(QUEUE, "rt-permanent", stateDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET enqueued_at = ?
          WHERE queue_name = ? AND id = ?`,
      ).run(Date.now() - 31 * 24 * 60 * 60_000, QUEUE, "rt-permanent");

      enqueueValid("rt-prune-trigger");
      completeDeliveryQueueEntry(QUEUE, "rt-prune-trigger", stateDir);

      expect(getDeliveryQueueEntryStatus(QUEUE, "rt-permanent", stateDir)).toBe("completed");
      const row = db
        .prepare(
          `SELECT recovery_state, entry_json
             FROM delivery_queue_entries
            WHERE queue_name = ? AND id = ?`,
        )
        .get(QUEUE, "rt-permanent") as Record<string, unknown>;
      expect(row.recovery_state).toBe("completed_permanent");
      expect(JSON.parse(String(row.entry_json))).toMatchObject({
        completionRetention: "permanent",
        recoveryState: "completed_permanent",
      });
    });
  });
});
