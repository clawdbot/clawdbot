// Covers session delivery queue persistence state transitions.
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { sha256Hex } from "./crypto-digest.js";
import { sweepDeliveryFailureMaintenance } from "./delivery-queue-failure-maintenance.js";
import {
  advanceSessionDeliveryAgentRun,
  completeSessionDelivery,
  deferSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  moveSessionDeliveryToFailed,
  resubmitSessionDelivery,
} from "./session-delivery-queue-storage.js";
import {
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue.js";

describe("session-delivery queue storage", () => {
  async function settleSessionDelivery(id: string, stateDir: string): Promise<void> {
    const entry = await loadPendingSessionDelivery(id, stateDir);
    if (!entry) {
      throw new Error(`Expected pending session delivery ${id}`);
    }
    await markSessionDeliverySettlement(entry, "recovered", stateDir);
    await completeSessionDelivery(id, stateDir);
  }

  function readSessionQueueStatus(tempDir: string, id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?")
      .get(id) as { status?: string } | undefined;
    return row?.status;
  }

  it("dedupes entries when an idempotency key is reused", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const firstId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );
      const secondId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );

      expect(secondId).toBe(firstId);
      expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(1);
    });
  });

  it("grants one initial-attempt lease and releases it for recovery", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-lease:agent-loop",
        idempotencyKey: "image:task-lease:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, tempDir);
      const duplicate = await enqueueClaimedSessionDelivery(payload, 60_000, tempDir);

      expect(first.claimed).toBe(true);
      expect(duplicate).toEqual({ id: first.id, claimed: false, status: "pending" });
      expect((await loadPendingSessionDeliveries(tempDir))[0]?.availableAt).toBeGreaterThan(
        Date.now(),
      );

      await releaseSessionDeliveryClaim(first.id, tempDir);
      expect((await loadPendingSessionDeliveries(tempDir))[0]?.availableAt).toBeLessThanOrEqual(
        Date.now(),
      );
    });
  });

  it("retains claimed failed ownership across resubmit and maintenance", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-dead-letter:agent-loop",
        idempotencyKey: "image:task-dead-letter:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, tempDir);
      await moveSessionDeliveryToFailed(first.id, tempDir);

      await expect(resubmitSessionDelivery(first.id, tempDir)).resolves.toEqual({
        ok: false,
        reason: "fenced",
      });
      await expect(enqueueSessionDelivery(payload, tempDir)).rejects.toMatchObject({
        name: "SessionDeliveryProducerRevivalError",
        code: "SESSION_DELIVERY_REVIVAL_FAILED",
      });
      await sweepDeliveryFailureMaintenance({
        stateDir: tempDir,
        now: Date.now() + 31 * 24 * 60 * 60_000,
      });

      await expect(enqueueClaimedSessionDelivery(payload, 60_000, tempDir)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "failed",
      });
    });
  });

  it("lets an explicit enqueue revive a failed idempotency key", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:revive-failed",
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      await moveSessionDeliveryToFailed(id, tempDir);

      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("pending");
      expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(1);
    });
  });

  it("revives a pre-upgrade failed row with no terminal policy", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:revive-pre-upgrade",
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const availableAt = Date.now() + 60_000;
      db.prepare(
        `UPDATE delivery_queue_entries
            SET status = 'failed', failed_at = ?,
                entry_json = ?, recovery_state = NULL
          WHERE queue_name = 'session' AND id = ?`,
      ).run(
        Date.now(),
        JSON.stringify({ ...payload, id, enqueuedAt: Date.now(), retryCount: 2, availableAt }),
        id,
      );

      await sweepDeliveryFailureMaintenance({ stateDir: tempDir, batchSize: 1 });
      const normalized = db
        .prepare(
          "SELECT entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(id) as { entry_json: string };
      expect(JSON.parse(normalized.entry_json)).toMatchObject({
        availableAt,
        terminalPolicy: {
          detail: "full",
          replay: "safe",
          evidence: "pre_side_effect",
          fence: { kind: "none" },
        },
      });

      await expect(enqueueSessionDelivery(payload, tempDir)).resolves.toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("pending");
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        text: "restart complete",
        retryCount: 0,
      });
      expect(await loadPendingSessionDelivery(id, tempDir)).not.toHaveProperty("availableAt");
    });
  });

  it.each([
    ["delivery-started", { deliveryStartedAt: 10 }, "ambiguous"],
    ["settled", { settlementOutcome: "recovered" }, "ambiguous"],
    ["acknowledged", { acknowledgedAt: 10 }, "ambiguous"],
    ["malformed owner", { owner: { kind: "subagent_completion" } }, "legacy_unknown"],
    ["required producer claim", { requiresProducerClaim: true }, "fenced"],
    ["active producer claim", { producerClaimId: "claim-1" }, "fenced"],
    ["failure retention", { failureRetention: "permanent" }, "fenced"],
    ["completion retention", { completionRetention: "permanent" }, "fenced"],
  ] as const)("refuses %s legacy producer revival", async (label, evidence, reason) => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: `restart:legacy-${label}`,
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const legacy = {
        ...payload,
        id,
        enqueuedAt: Date.now(),
        retryCount: 2,
        ...evidence,
      };
      db.prepare(
        `UPDATE delivery_queue_entries
            SET status = 'failed', failed_at = ?, entry_json = ?, recovery_state = NULL
          WHERE queue_name = 'session' AND id = ?`,
      ).run(Date.now(), JSON.stringify(legacy), id);

      await expect(enqueueSessionDelivery(payload, tempDir)).rejects.toMatchObject({
        name: "SessionDeliveryProducerRevivalError",
        reason,
      });
      expect(readSessionQueueStatus(tempDir, id)).toBe("failed");
      const retained = db
        .prepare(
          "SELECT entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(id) as { entry_json: string };
      expect(JSON.parse(retained.entry_json)).toEqual(legacy);
      if (label === "delivery-started" || label === "malformed owner") {
        await sweepDeliveryFailureMaintenance({ stateDir: tempDir, batchSize: 1 });
        const normalized = db
          .prepare(
            "SELECT entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
          )
          .get(id) as { entry_json: string };
        expect(JSON.parse(normalized.entry_json)).toMatchObject({
          terminalPolicy: {
            detail: "compacted",
            replay: "ambiguous",
            fence: { kind: "permanent" },
            reason: "legacy_unknown",
          },
        });
      }
    });
  });

  it.each([
    ["corrupt", "{corrupt", "legacy_unknown"],
    [
      "payload-free compact",
      JSON.stringify({
        id: "placeholder",
        enqueuedAt: 1,
        retryCount: 2,
        recoveryState: "failed_terminal_v1",
      }),
      "compacted",
    ],
  ] as const)("fails closed for %s legacy failed detail", async (label, rawEntry, reason) => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: `restart:legacy-${label}`,
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const entryJson = rawEntry.replace("placeholder", id);
      db.prepare(
        `UPDATE delivery_queue_entries
            SET status = 'failed', failed_at = ?, entry_json = ?, recovery_state = ?
          WHERE queue_name = 'session' AND id = ?`,
      ).run(
        Date.now(),
        entryJson,
        label === "payload-free compact" ? "failed_terminal_v1" : null,
        id,
      );

      await expect(enqueueSessionDelivery(payload, tempDir)).rejects.toMatchObject({
        name: "SessionDeliveryProducerRevivalError",
        reason,
      });
      expect(readSessionQueueStatus(tempDir, id)).toBe("failed");
    });
  });

  it("surfaces a typed failure when explicit producer replacement loses its CAS", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:revive-cas-failure",
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      await moveSessionDeliveryToFailed(id, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.exec(`
        CREATE TRIGGER reject_session_delivery_revival
        BEFORE UPDATE ON delivery_queue_entries
        WHEN OLD.queue_name = 'session' AND OLD.id = '${id}'
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);

      await expect(enqueueSessionDelivery(payload, tempDir)).rejects.toMatchObject({
        name: "SessionDeliveryProducerRevivalError",
        code: "SESSION_DELIVERY_REVIVAL_FAILED",
        message: expect.stringContaining("ownership changed during replacement"),
      });
      expect(readSessionQueueStatus(tempDir, id)).toBe("failed");
    });
  });

  it("resubmits an explicitly safe ownerless failure exactly once", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );
      await moveSessionDeliveryToFailed(id, tempDir);

      await expect(resubmitSessionDelivery(id, tempDir)).resolves.toEqual({ ok: true });
      await expect(resubmitSessionDelivery(id, tempDir)).resolves.toEqual({
        ok: false,
        reason: "not_failed",
      });
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        id,
        retryCount: 0,
        text: "restart complete",
      });
    });
  });

  it("compacts settlement ambiguity and refuses generic resubmit", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:secret",
        message: "sensitive completion",
        messageId: "ambiguous-settlement",
        idempotencyKey: "ambiguous-settlement",
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      const entry = await loadPendingSessionDelivery(id, tempDir);
      if (!entry) {
        throw new Error("expected pending session delivery");
      }
      await markSessionDeliveryAttemptStarted(entry, tempDir);
      const started = await loadPendingSessionDelivery(id, tempDir);
      if (!started) {
        throw new Error("expected started session delivery");
      }
      await markSessionDeliverySettlement(started, "moved-to-failed", tempDir);
      await moveSessionDeliveryToFailed(id, tempDir);

      await expect(resubmitSessionDelivery(id, tempDir)).resolves.toEqual({
        ok: false,
        reason: "compacted",
      });
      await expect(enqueueSessionDelivery(payload, tempDir)).rejects.toMatchObject({
        name: "SessionDeliveryProducerRevivalError",
        reason: "compacted",
      });
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const row = db
        .prepare(
          "SELECT session_key, channel, target, account_id, last_error, entry_json FROM delivery_queue_entries WHERE queue_name='session' AND id=?",
        )
        .get(id) as Record<string, unknown>;
      expect(row).toMatchObject({
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
        last_error: null,
      });
      expect(String(row.entry_json)).not.toContain("sensitive completion");
      expect(JSON.parse(String(row.entry_json))).toMatchObject({
        terminalPolicy: {
          detail: "compacted",
          replay: "ambiguous",
          evidence: "settled",
          settlementOutcome: "moved-to-failed",
        },
      });
    });
  });

  it("never revives a failed permanent producer intent", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:permanent-failed",
        completionRetention: "permanent" as const,
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      await moveSessionDeliveryToFailed(id, tempDir);

      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("failed");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("reports a completed conflict after acknowledgement", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-completed:agent-loop",
        idempotencyKey: "image:task-completed:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, tempDir);
      await settleSessionDelivery(first.id, tempDir);

      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(first.id);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");

      await expect(enqueueClaimedSessionDelivery(payload, 60_000, tempDir)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "completed",
      });
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
      expect(readSessionQueueStatus(tempDir, first.id)).toBe("completed");
    });
  });

  it("reuses an idempotency key when its bounded completion receipt expires", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const idempotencyKey = "image:task-completed:bounded-reuse";
      const id = sha256Hex(idempotencyKey);
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "first completion",
        idempotencyKey,
        completionRetention: { idPrefix: id.slice(0, 8), maxAgeMs: 1_000, maxEntries: 10 },
      };
      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(id);
      await settleSessionDelivery(id, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        "UPDATE delivery_queue_entries SET enqueued_at = 0 WHERE queue_name = 'session' AND id = ?",
      ).run(id);

      await expect(
        enqueueSessionDelivery({ ...payload, text: "replacement completion" }, tempDir),
      ).resolves.toBe(id);
      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toMatchObject({
        text: "replacement completion",
      });
    });
  });

  it("atomically repairs unreadable pending JSON for an idempotent enqueue", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:repair-corrupt-pending",
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET entry_json = '{corrupt'
          WHERE queue_name = 'session' AND id = ?`,
      ).run(id);

      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(id);
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([
        expect.objectContaining({ id, text: "restart complete" }),
      ]);
    });
  });

  it("persists retry metadata and retains acked idempotency tombstones", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      await failSessionDelivery(id, "dispatch failed", tempDir);
      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("dispatch failed");

      await settleSessionDelivery(id, tempDir);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
    });
  });

  it("retains ambiguous attempt ownership and clears it only for a safe retry", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-attempt-owner:agent-loop",
        },
        tempDir,
      );
      const entry = await loadPendingSessionDelivery(id, tempDir);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }

      await markSessionDeliveryAttemptStarted(entry, tempDir);
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        deliveryStartedAt: expect.any(Number),
      });

      await failSessionDelivery(id, "ambiguous failure after send", tempDir);
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        deliveryStartedAt: expect.any(Number),
      });

      await failSessionDelivery(id, "safe failure before commit", tempDir, {
        releaseAttemptOwnership: true,
      });
      expect(await loadPendingSessionDelivery(id, tempDir)).not.toHaveProperty("deliveryStartedAt");
    });
  });

  it("records which agent run attempt consumed retry budget", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-charge:agent-loop",
        },
        tempDir,
      );

      await failSessionDelivery(id, "delivery failed", tempDir);
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        retryCount: 1,
        lastChargedAgentRunAttempt: 0,
      });

      await advanceSessionDeliveryAgentRun(id, undefined, tempDir);
      await failSessionDelivery(id, "fresh delivery failed", tempDir);
      expect(await loadPendingSessionDelivery(id, tempDir)).toMatchObject({
        retryCount: 2,
        agentRunAttempt: 1,
        lastChargedAgentRunAttempt: 1,
      });
    });
  });

  it("persists agent-loop routing and provenance for restart replay", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:discord:channel:123",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
          route: {
            channel: "discord",
            to: "channel:123",
            accountId: "default",
            chatType: "channel",
          },
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "image_generate:task-1",
            sourceChannel: "webchat",
            sourceTool: "image_generate",
          },
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        },
        tempDir,
      );

      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([
        expect.objectContaining({
          route: expect.objectContaining({ channel: "discord", to: "channel:123" }),
          inputProvenance: expect.objectContaining({ sourceTool: "image_generate" }),
          sourceReplyDeliveryMode: "message_tool_only",
          expectedMediaUrls: ["/tmp/proof.png"],
        }),
      ]);
    });
  });

  it("advances only the agent run attempt and can focus its retry media", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "all generated media",
          messageId: "image:task-retry:agent-loop",
          expectedMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        },
        tempDir,
      );

      await failSessionDelivery(id, "ambiguous timeout", tempDir);
      await deferSessionDelivery(id, 1_000, tempDir);
      let [entry] = await loadPendingSessionDeliveries(tempDir);
      expect(entry).toMatchObject({ retryCount: 1 });
      expect(entry?.agentRunAttempt).toBeUndefined();
      expect(entry?.availableAt).toBeGreaterThan(Date.now());

      await advanceSessionDeliveryAgentRun(
        id,
        {
          message: "only missing media",
          expectedMediaUrls: ["/tmp/two.png"],
          suppressTextDelivery: true,
        },
        tempDir,
      );
      [entry] = await loadPendingSessionDeliveries(tempDir);
      expect(entry).toMatchObject({
        agentRunAttempt: 1,
        retryCount: 1,
        message: "only missing media",
        expectedMediaUrls: ["/tmp/two.png"],
        suppressTextDelivery: true,
      });
    });
  });

  it("moves entries into completed idempotency state", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      await settleSessionDelivery(id, tempDir);

      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
    });
  });

  it("retains a permanent completion receipt", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "systemEvent" as const,
        sessionKey: "agent:main:main",
        text: "restart complete",
        idempotencyKey: "restart:permanent-completed",
        completionRetention: "permanent" as const,
      };
      const id = await enqueueSessionDelivery(payload, tempDir);
      await settleSessionDelivery(id, tempDir);

      expect(await enqueueSessionDelivery(payload, tempDir)).toBe(id);
      expect(readSessionQueueStatus(tempDir, id)).toBe("completed");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });
});
