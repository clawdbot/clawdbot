// Failed delivery policy tests cover privacy compaction, retention fences, and CAS safety.
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  getDeliveryFailureMaintenanceHealth,
  sweepDeliveryFailureMaintenance,
} from "./delivery-queue-failure-maintenance.js";
import { summarizeDeliveryFailureQueues } from "./delivery-queue-failure-summary.js";
import {
  compactFailedDeliveryQueueEntry,
  loadRetainedFailedDeliveryEntries,
  purgeDeliveryFailures,
} from "./delivery-queue-failures.js";
import {
  commitStagedDeliveryQueueEntryOnceAcrossNamespaces,
  movePendingDeliveryQueueEntryNamespace,
  upsertDeliveryQueueEntryOnceAcrossNamespaces,
} from "./delivery-queue-sqlite-namespace.js";
import {
  getDeliveryQueueEntryStatus,
  moveDeliveryQueueEntryToFailed,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import type { DeliveryQueueTerminalPolicy } from "./delivery-queue-sqlite.types.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";

function safePolicy(
  fence: DeliveryQueueTerminalPolicy["fence"] = { kind: "none" },
): DeliveryQueueTerminalPolicy {
  return {
    version: 1,
    detail: "full",
    replay: "safe",
    fence,
    reason: "retry_exhausted",
    payload: "present",
    cleanup: "complete",
    evidence: "pre_side_effect",
  };
}

describe("delivery failure retention", () => {
  it("counts and protects both pending owner cleanup phases", async () => {
    await withTestDir({ prefix: "openclaw-delivery-owner-cleanup-" }, async (stateDir) => {
      for (const cleanup of ["pending", "media_pending"] as const) {
        const id = `owner-${cleanup}`;
        const policy: DeliveryQueueTerminalPolicy = {
          version: 1,
          detail: "full",
          replay: "owner-managed",
          fence: { kind: "permanent" },
          reason: "retry_exhausted",
          payload: "present",
          cleanup,
          evidence: "owner_managed",
          owner: "durable_delivery",
          detailExpiresAt: 1,
        };
        upsertDeliveryQueueEntry({
          queueName: "outbound-prepared-v1",
          entry: { id, enqueuedAt: 1, retryCount: 0, terminalPolicy: policy },
          stateDir,
        });
        moveDeliveryQueueEntryToFailed("outbound-prepared-v1", id, policy, stateDir);
      }

      expect(summarizeDeliveryFailureQueues(stateDir)).toEqual([
        expect.objectContaining({
          queueName: "outbound-prepared-v1",
          count: 2,
          full: 2,
          ownerManaged: 2,
          ownerCleanupPending: 2,
          payloadBearing: 2,
        }),
      ]);
      expect(
        loadRetainedFailedDeliveryEntries(["outbound-prepared-v1"], stateDir)
          .map((entry) => entry.id)
          .toSorted(),
      ).toEqual(["owner-media_pending", "owner-pending"]);
      await expect(
        sweepDeliveryFailureMaintenance({ stateDir, now: Date.now() + 60_000 }),
      ).resolves.toMatchObject({ compacted: 0, deleted: 0, errors: 0 });
      await expect(
        purgeDeliveryFailures({ stateDir, apply: true, now: Date.now() + 60_000 }),
      ).resolves.toMatchObject({ compacted: 0, deleted: 0, errors: 0 });

      const rows = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      })
        .db.prepare(
          "SELECT entry_json FROM delivery_queue_entries WHERE queue_name = 'outbound-prepared-v1' ORDER BY id",
        )
        .all() as Array<{ entry_json: string }>;
      expect(rows.map((row) => JSON.parse(row.entry_json).terminalPolicy)).toEqual([
        expect.objectContaining({ detail: "full", cleanup: "media_pending" }),
        expect.objectContaining({ detail: "full", cleanup: "pending" }),
      ]);
    });
  });

  it("compacts sensitive detail while preserving failed ownership and diagnostics", async () => {
    await withTestDir({ prefix: "openclaw-delivery-failure-" }, async (stateDir) => {
      const id = "stable:secret-route";
      upsertDeliveryQueueEntry({
        queueName: "outbound-prepared-v1",
        entry: {
          id,
          enqueuedAt: 1_000,
          retryCount: 4,
          channel: "discord",
          to: "channel:private",
          accountId: "owner",
          lastError: "raw provider error",
          terminalPolicy: safePolicy({ kind: "permanent" }),
        } as DeliveryQueueEntryState & {
          channel: string;
          to: string;
          accountId: string;
        },
        stateDir,
      });
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      moveDeliveryQueueEntryToFailed(
        "outbound-prepared-v1",
        id,
        safePolicy({ kind: "permanent" }),
        stateDir,
      );
      expect(
        compactFailedDeliveryQueueEntry({ queueName: "outbound-prepared-v1", id, stateDir }),
      ).toBe(true);
      vi.useRealTimers();

      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const row = db
        .prepare(
          `SELECT status, failed_at, retry_count, session_key, channel, target, account_id,
                  last_error, platform_send_started_at, recovery_state, entry_json
             FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
        )
        .get("outbound-prepared-v1", id) as Record<string, unknown>;
      expect(row).toMatchObject({
        status: "failed",
        failed_at: 50_000,
        retry_count: 4,
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        last_error: null,
        platform_send_started_at: null,
        recovery_state: "failed_terminal_v1",
      });
      expect(JSON.parse(String(row.entry_json))).toEqual({
        id,
        enqueuedAt: 1_000,
        retryCount: 4,
        recoveryState: "failed_terminal_v1",
        terminalPolicy: expect.objectContaining({
          version: 1,
          detail: "compacted",
          replay: "safe",
          fence: { kind: "permanent" },
          payload: "none",
        }),
      });
      expect(String(row.entry_json)).not.toContain("private");
      expect(String(row.entry_json)).not.toContain("provider error");
    });
  });

  it("normalizes corrupt legacy failures into unknown permanent tombstones", async () => {
    await withTestDir({ prefix: "openclaw-delivery-legacy-" }, async (stateDir) => {
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,session_key,channel,target,account_id,retry_count,
           last_attempt_at,last_error,recovery_state,platform_send_started_at,entry_json,
           enqueued_at,updated_at,failed_at)
         VALUES ('outbound','legacy-secret','failed','outbound','session-secret','slack','C1','A1',
                 2,10,'raw secret',NULL,NULL,'{corrupt',1,2,3)`,
      ).run();

      const result = await sweepDeliveryFailureMaintenance({ stateDir, batchSize: 10 });
      expect(result).toMatchObject({ compacted: 1, legacyUnknown: 1, errors: 0 });
      const row = db
        .prepare(
          "SELECT status, failed_at, retry_count, session_key, channel, target, account_id, last_error, entry_json FROM delivery_queue_entries WHERE queue_name='outbound' AND id='legacy-secret'",
        )
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        status: "failed",
        failed_at: 3,
        retry_count: 2,
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        last_error: null,
      });
      expect(JSON.parse(String(row.entry_json))).toMatchObject({
        terminalPolicy: {
          version: 1,
          detail: "compacted",
          replay: "ambiguous",
          fence: { kind: "permanent" },
          reason: "legacy_unknown",
        },
      });
    });
  });

  it("canonicalizes legacy subagent owners until their detail retention expires", async () => {
    await withTestDir({ prefix: "openclaw-delivery-owner-legacy-" }, async (stateDir) => {
      const failedAt = 1_000_000;
      const detailExpiresAt = failedAt + 7 * 24 * 60 * 60_000;
      const owner = {
        kind: "subagent_completion",
        runId: "run-legacy-owner",
        taskId: "task-legacy-owner",
        generation: 3,
        deadlineAt: failedAt - 1,
      } as const;
      const entry = {
        id: "legacy-owner",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "retained completion payload",
        messageId: "completion:legacy-owner",
        route: {
          channel: "discord",
          to: "private-channel",
          chatType: "direct",
        },
        owner,
        failureRetention: "permanent",
        availableAt: failedAt - 1,
        enqueuedAt: failedAt - 10_000,
        retryCount: 5,
        lastError: "requester unavailable",
      };
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,session_key,channel,target,retry_count,last_error,
           entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session',?,'failed','agentTurn',?,?,?,5,?,?,?,?,?)`,
      ).run(
        entry.id,
        entry.sessionKey,
        entry.route.channel,
        entry.route.to,
        entry.lastError,
        JSON.stringify(entry),
        entry.enqueuedAt,
        failedAt,
        failedAt,
      );

      await expect(
        sweepDeliveryFailureMaintenance({ stateDir, batchSize: 10, now: failedAt }),
      ).resolves.toMatchObject({ scanned: 1, compacted: 0, legacyUnknown: 0, errors: 0 });
      const canonical = db
        .prepare(
          `SELECT session_key, channel, target, last_error, entry_json
             FROM delivery_queue_entries WHERE queue_name='session' AND id=?`,
        )
        .get(entry.id) as Record<string, unknown>;
      expect(canonical).toMatchObject({
        session_key: entry.sessionKey,
        channel: entry.route.channel,
        target: entry.route.to,
        last_error: entry.lastError,
      });
      expect(JSON.parse(String(canonical.entry_json))).toEqual({
        ...entry,
        terminalPolicy: {
          version: 1,
          detail: "full",
          replay: "owner-managed",
          fence: { kind: "permanent" },
          reason: "owner_expired",
          payload: "present",
          cleanup: "complete",
          evidence: "owner_managed",
          owner: "subagent_completion",
          detailExpiresAt,
        },
      });

      await expect(
        sweepDeliveryFailureMaintenance({
          stateDir,
          batchSize: 10,
          now: detailExpiresAt,
        }),
      ).resolves.toMatchObject({ scanned: 1, compacted: 1, legacyUnknown: 0, errors: 0 });
      const compacted = db
        .prepare(
          "SELECT session_key, channel, target, last_error, entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(entry.id) as Record<string, unknown>;
      expect(compacted).toMatchObject({
        session_key: null,
        channel: null,
        target: null,
        last_error: null,
      });
      expect(JSON.parse(String(compacted.entry_json))).toMatchObject({
        terminalPolicy: {
          detail: "compacted",
          replay: "owner-managed",
          reason: "owner_expired",
          owner: "subagent_completion",
        },
      });
    });
  });

  it("keeps health, retention, and replay-media JSON1 reads safe on malformed legacy JSON", async () => {
    await withTestDir({ prefix: "openclaw-delivery-json1-" }, async (stateDir) => {
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const bounded = safePolicy({
        kind: "producer-bounded",
        idPrefix: "producer:",
        maxAgeMs: 10_000,
        maxEntries: 10,
      });
      const compacted: DeliveryQueueTerminalPolicy = {
        ...safePolicy({ kind: "permanent" }),
        detail: "compacted",
        payload: "none",
      };
      const insert = db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('outbound-prepared-v1',?,'failed','outbound',0,?,?,?,1)`,
      );
      for (const [id, policy, updatedAt] of [
        ["safe-valid", safePolicy(), 1],
        ["compact-valid", compacted, 2],
        ["producer:valid", bounded, 3],
      ] as const) {
        insert.run(
          id,
          JSON.stringify({ id, enqueuedAt: 1, retryCount: 0, terminalPolicy: policy }),
          1,
          updatedAt,
        );
      }
      insert.run("producer:malformed", "{malformed", 1, 4);

      expect(summarizeDeliveryFailureQueues(stateDir)).toEqual([
        expect.objectContaining({
          queueName: "outbound-prepared-v1",
          count: 4,
          full: 2,
          compacted: 1,
          ownerCleanupPending: 0,
          fenceProducerBounded: 1,
          legacyUnknown: 1,
          payloadBearing: 2,
        }),
      ]);
      expect(
        loadRetainedFailedDeliveryEntries(["outbound-prepared-v1"], stateDir)
          .map((entry) => entry.id)
          .toSorted(),
      ).toEqual(["safe-valid"]);

      await expect(
        sweepDeliveryFailureMaintenance({ stateDir, batchSize: 10, now: 100 }),
      ).resolves.toMatchObject({ scanned: 3, compacted: 1, legacyUnknown: 1, errors: 0 });
      const malformed = db
        .prepare(
          "SELECT status, recovery_state, entry_json FROM delivery_queue_entries WHERE id='producer:malformed'",
        )
        .get() as Record<string, unknown>;
      expect(malformed).toMatchObject({ status: "failed", recovery_state: "failed_terminal_v1" });
      expect(JSON.parse(String(malformed.entry_json))).toMatchObject({
        terminalPolicy: { reason: "legacy_unknown", fence: { kind: "permanent" } },
      });
    });
  });

  it("expires bounded failed fences inside exact stable admission without crossing prefixes", async () => {
    await withTestDir({ prefix: "openclaw-delivery-admission-" }, async (stateDir) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const expiredId = "producer-a:expired";
        const retainedId = "producer-b:retained";
        const boundedA = {
          kind: "producer-bounded" as const,
          idPrefix: "producer-a:",
          maxAgeMs: 1_000,
          maxEntries: 1,
        };
        for (const [id, fence] of [
          [expiredId, boundedA],
          [
            retainedId,
            {
              kind: "producer-bounded" as const,
              idPrefix: "producer-b:",
              maxAgeMs: 60_000,
              maxEntries: 1,
            },
          ],
        ] as const) {
          upsertDeliveryQueueEntry({
            queueName: "outbound",
            entry: { id, enqueuedAt: Date.now(), retryCount: 0, terminalPolicy: safePolicy(fence) },
            stateDir,
          });
          moveDeliveryQueueEntryToFailed("outbound", id, safePolicy(fence), stateDir);
        }
        vi.setSystemTime(11_001);
        expect(
          upsertDeliveryQueueEntryOnceAcrossNamespaces({
            queueName: "outbound-prepared-v1",
            conflictQueueNames: ["outbound"],
            entry: { id: expiredId, enqueuedAt: Date.now(), retryCount: 0 },
            stateDir,
          }),
        ).toBe(true);
        expect(getDeliveryQueueEntryStatus("outbound", expiredId, stateDir)).toBeUndefined();
        expect(
          upsertDeliveryQueueEntryOnceAcrossNamespaces({
            queueName: "outbound-prepared-v1",
            conflictQueueNames: ["outbound"],
            entry: { id: retainedId, enqueuedAt: Date.now(), retryCount: 0 },
            stateDir,
          }),
        ).toBe(false);

        const countFence = {
          kind: "producer-bounded" as const,
          idPrefix: "producer-count:",
          maxAgeMs: 60_000,
          maxEntries: 1,
        };
        for (const id of ["producer-count:old", "producer-count:new"]) {
          vi.setSystemTime(Date.now() + 1);
          upsertDeliveryQueueEntry({
            queueName: "outbound",
            entry: {
              id,
              enqueuedAt: Date.now(),
              retryCount: 0,
              terminalPolicy: safePolicy(countFence),
            },
            stateDir,
          });
          moveDeliveryQueueEntryToFailed("outbound", id, safePolicy(countFence), stateDir);
        }
        expect(
          upsertDeliveryQueueEntryOnceAcrossNamespaces({
            queueName: "outbound-prepared-v1",
            conflictQueueNames: ["outbound"],
            entry: { id: "producer-count:old", enqueuedAt: Date.now(), retryCount: 0 },
            stateDir,
          }),
        ).toBe(true);
        expect(getDeliveryQueueEntryStatus("outbound", "producer-count:new", stateDir)).toBe(
          "failed",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("blocks permanent and compact unknown fences across current and retired namespaces", async () => {
    await withTestDir({ prefix: "openclaw-delivery-fences-" }, async (stateDir) => {
      for (const [queueName, id, policy] of [
        ["outbound-prepared-v1", "permanent-current", safePolicy({ kind: "permanent" })],
        [
          "outbound",
          "unknown-retired",
          {
            version: 1,
            detail: "compacted",
            replay: "ambiguous",
            fence: { kind: "permanent" },
            reason: "legacy_unknown",
            payload: "none",
            cleanup: "complete",
            evidence: "legacy_unknown",
          } satisfies DeliveryQueueTerminalPolicy,
        ],
      ] as const) {
        upsertDeliveryQueueEntry({
          queueName,
          entry: { id, enqueuedAt: 1, retryCount: 0, terminalPolicy: policy },
          stateDir,
        });
        moveDeliveryQueueEntryToFailed(queueName, id, policy, stateDir);
        compactFailedDeliveryQueueEntry({ queueName, id, stateDir, policy });
        expect(
          upsertDeliveryQueueEntryOnceAcrossNamespaces({
            queueName: "outbound-prepared-v1",
            conflictQueueNames: ["outbound"],
            entry: { id, enqueuedAt: 2, retryCount: 0 },
            stateDir,
          }),
        ).toBe(false);
      }
    });
  });

  it("expires bounded destination fences inside preparation publication", async () => {
    await withTestDir({ prefix: "openclaw-delivery-move-fence-" }, async (stateDir) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const id = "prepared-bounded:expired";
        const fence = {
          kind: "producer-bounded" as const,
          idPrefix: "prepared-bounded:",
          maxAgeMs: 100,
          maxEntries: 10,
        };
        const source = {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          preparationState: "prepared",
        };
        upsertDeliveryQueueEntry({
          queueName: "outbound-preparing-v1",
          entry: source,
          stateDir,
        });
        upsertDeliveryQueueEntry({
          queueName: "outbound-prepared-v1",
          entry: { id, enqueuedAt: Date.now(), retryCount: 0, terminalPolicy: safePolicy(fence) },
          stateDir,
        });
        moveDeliveryQueueEntryToFailed("outbound-prepared-v1", id, safePolicy(fence), stateDir);
        const stagedId = "prepared-bounded:staged-expired";
        upsertDeliveryQueueEntry({
          queueName: "outbound-media-staging",
          entry: { id: "media-stage", enqueuedAt: Date.now(), retryCount: 0 },
          stateDir,
        });
        upsertDeliveryQueueEntry({
          queueName: "outbound",
          entry: {
            id: stagedId,
            enqueuedAt: Date.now(),
            retryCount: 0,
            terminalPolicy: safePolicy(fence),
          },
          stateDir,
        });
        moveDeliveryQueueEntryToFailed("outbound", stagedId, safePolicy(fence), stateDir);
        vi.setSystemTime(10_101);

        expect(
          movePendingDeliveryQueueEntryNamespace({
            sourceQueueName: "outbound-preparing-v1",
            destinationQueueName: "outbound-prepared-v1",
            expectedSourceEntry: source,
            destinationEntry: { id, enqueuedAt: Date.now(), retryCount: 0 },
            stateDir,
          }),
        ).toBe("moved");
        expect(getDeliveryQueueEntryStatus("outbound-preparing-v1", id, stateDir)).toBeUndefined();
        expect(getDeliveryQueueEntryStatus("outbound-prepared-v1", id, stateDir)).toBe("pending");
        expect(
          commitStagedDeliveryQueueEntryOnceAcrossNamespaces({
            queueName: "outbound-prepared-v1",
            conflictQueueNames: ["outbound"],
            entry: { id: stagedId, enqueuedAt: Date.now(), retryCount: 0 },
            stagingQueueName: "outbound-media-staging",
            stagingId: "media-stage",
            stateDir,
          }),
        ).toBe("created");
        expect(getDeliveryQueueEntryStatus("outbound", stagedId, stateDir)).toBeUndefined();
        expect(getDeliveryQueueEntryStatus("outbound-prepared-v1", stagedId, stateDir)).toBe(
          "pending",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("bounds full safe detail to 20,000 rows per canonical queue", async () => {
    await withTestDir({ prefix: "openclaw-delivery-count-" }, async (stateDir) => {
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const insert = db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session',?,'failed','systemEvent',0,?,?,1,?)`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index <= 20_000; index += 1) {
          const id = `safe-${String(index).padStart(5, "0")}`;
          insert.run(
            id,
            JSON.stringify({
              id,
              enqueuedAt: index,
              retryCount: 0,
              text: "bounded detail",
              terminalPolicy: safePolicy(),
            }),
            index,
            index,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const result = await sweepDeliveryFailureMaintenance({
        stateDir,
        batchSize: 500,
        now: 20_000,
      });
      expect(result.scanned).toBe(20_001);
      expect(result.deleted).toBe(1);
      expect(getDeliveryQueueEntryStatus("session", "safe-00000", stateDir)).toBeUndefined();
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries WHERE queue_name='session'")
        .get() as { count: number };
      expect(count.count).toBe(20_000);
    });
  });

  it("sweeps every actionable batch with event-loop yields and skips settled tombstones", async () => {
    await withTestDir({ prefix: "openclaw-delivery-sweep-" }, async (stateDir) => {
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const insert = db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session',?,'failed','systemEvent',0,?,?,?,1)`,
      );
      for (const [index, id, policy] of [
        [1, "permanent-a", safePolicy({ kind: "permanent" })],
        [2, "permanent-b", safePolicy({ kind: "permanent" })],
        [3, "expired-unfenced", safePolicy()],
        [4, "permanent-c", safePolicy({ kind: "permanent" })],
      ] as const) {
        insert.run(
          id,
          JSON.stringify({
            id,
            enqueuedAt: 1,
            retryCount: 0,
            text: "sensitive detail",
            terminalPolicy: policy,
          }),
          1,
          index,
        );
      }
      vi.useFakeTimers();
      try {
        const sweep = sweepDeliveryFailureMaintenance({
          stateDir,
          batchSize: 2,
          now: 31 * 24 * 60 * 60_000,
        });
        expect(getDeliveryQueueEntryStatus("session", "expired-unfenced", stateDir)).toBe("failed");

        await vi.runAllTimersAsync();
        await expect(sweep).resolves.toMatchObject({
          scanned: 4,
          compacted: 3,
          deleted: 1,
          errors: 0,
        });
        expect(
          getDeliveryQueueEntryStatus("session", "expired-unfenced", stateDir),
        ).toBeUndefined();
        for (const id of ["permanent-a", "permanent-b", "permanent-c"]) {
          expect(getDeliveryQueueEntryStatus("session", id, stateDir)).toBe("failed");
          const row = db
            .prepare(
              "SELECT entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
            )
            .get(id) as { entry_json: string };
          expect(JSON.parse(row.entry_json)).toMatchObject({
            terminalPolicy: { detail: "compacted", fence: { kind: "permanent" } },
          });
        }
        await expect(
          sweepDeliveryFailureMaintenance({ stateDir, batchSize: 2, now: 32 * 24 * 60 * 60_000 }),
        ).resolves.toMatchObject({ scanned: 0, compacted: 0, deleted: 0, errors: 0 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("publishes aggregate maintenance health only after the full sweep", async () => {
    await withTestDir({ prefix: "openclaw-delivery-sweep-health-" }, async (stateDir) => {
      await sweepDeliveryFailureMaintenance({ stateDir, batchSize: 1, now: 100 });
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const insert = db.prepare(
        `INSERT INTO delivery_queue_entries
          (queue_name,id,status,entry_kind,retry_count,entry_json,enqueued_at,updated_at,failed_at)
         VALUES ('session',?,'failed','systemEvent',0,?,?,?,1)`,
      );
      for (const [index, id] of [
        [1, "error-row"],
        [2, "success-row"],
      ] as const) {
        insert.run(
          id,
          JSON.stringify({
            id,
            enqueuedAt: 1,
            retryCount: 0,
            text: "sensitive detail",
            terminalPolicy: safePolicy({ kind: "permanent" }),
          }),
          1,
          index,
        );
      }
      db.exec(`CREATE TRIGGER fail_delivery_maintenance_update
        BEFORE UPDATE ON delivery_queue_entries WHEN OLD.id = 'error-row'
        BEGIN SELECT RAISE(ABORT, 'blocked maintenance update'); END`);
      vi.useFakeTimers();
      try {
        const sweep = sweepDeliveryFailureMaintenance({
          stateDir,
          batchSize: 1,
          now: 31 * 24 * 60 * 60_000,
        });
        expect(getDeliveryFailureMaintenanceHealth()).toEqual({ runAt: 100, errors: 0 });

        await vi.runAllTimersAsync();
        await expect(sweep).resolves.toMatchObject({ scanned: 2, compacted: 1, errors: 1 });
        expect(getDeliveryFailureMaintenanceHealth()).toEqual({
          runAt: 31 * 24 * 60 * 60_000,
          errors: 1,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not compact a row revived before the CAS transaction", async () => {
    await withTestDir({ prefix: "openclaw-delivery-reopen-" }, async (stateDir) => {
      const id = "revived";
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: { id, enqueuedAt: 1, retryCount: 0, terminalPolicy: safePolicy() },
        stateDir,
      });
      moveDeliveryQueueEntryToFailed("session", id, safePolicy(), stateDir);
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: { id, enqueuedAt: 2, retryCount: 0 },
        stateDir,
        reviveFailedOrCorruptPending: true,
      });
      expect(compactFailedDeliveryQueueEntry({ queueName: "session", id, stateDir })).toBe(false);
      expect(getDeliveryQueueEntryStatus("session", id, stateDir)).toBe("pending");
    });
  });

  it("keeps compact failures invisible to older pending readers across a same-version reopen", async () => {
    await withTestDir({ prefix: "openclaw-delivery-reopen-" }, async (stateDir) => {
      const id = "compact-reopen";
      const policy = safePolicy({ kind: "permanent" });
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: { id, enqueuedAt: 1, retryCount: 2, terminalPolicy: policy },
        stateDir,
      });
      moveDeliveryQueueEntryToFailed("session", id, policy, stateDir);
      expect(compactFailedDeliveryQueueEntry({ queueName: "session", id, stateDir })).toBe(true);
      const before = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      })
        .db.prepare("PRAGMA user_version")
        .get();
      closeOpenClawStateDatabaseForTest();
      const reopened = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual(before);
      expect(
        reopened.db
          .prepare(
            "SELECT id FROM delivery_queue_entries WHERE queue_name='session' AND status='pending'",
          )
          .all(),
      ).toEqual([]);
      expect(
        reopened.db
          .prepare(
            "SELECT status, recovery_state FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
          )
          .get(id),
      ).toEqual({ status: "failed", recovery_state: "failed_terminal_v1" });
    });
  });
});
