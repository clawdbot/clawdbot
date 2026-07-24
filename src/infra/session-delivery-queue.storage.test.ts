// Covers session delivery queue persistence state transitions.
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  advanceSessionDeliveryAgentRun,
  completeSessionDelivery,
  deferSessionDelivery,
  enqueuePostCompactionDelegateDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  moveSessionDeliveryToFailed,
  type QueuedSessionDeliveryPayload,
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

  function readSessionQueueRow(
    tempDir: string,
    id: string,
  ): { status: string; entry_json: string; last_error: string | null } | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    return db
      .prepare(
        `SELECT status, entry_json, last_error
           FROM delivery_queue_entries
          WHERE queue_name = 'session' AND id = ?`,
      )
      .get(id) as { status: string; entry_json: string; last_error: string | null } | undefined;
  }

  function rewriteSessionQueueEntry(
    tempDir: string,
    id: string,
    update: (entry: Record<string, unknown>) => void,
  ): void {
    const current = readSessionQueueRow(tempDir, id);
    if (!current) {
      throw new Error(`Expected session delivery row ${id}`);
    }
    const entry = JSON.parse(current.entry_json) as Record<string, unknown>;
    update(entry);
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    db.prepare(
      `UPDATE delivery_queue_entries
          SET entry_json = ?
        WHERE queue_name = 'session' AND id = ?`,
    ).run(JSON.stringify(entry), id);
  }

  function rewriteSessionQueueEntryKind(
    tempDir: string,
    id: string,
    entryKind: string | null,
  ): void {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    db.prepare(
      `UPDATE delivery_queue_entries
          SET entry_kind = ?
        WHERE queue_name = 'session' AND id = ?`,
    ).run(entryKind, id);
  }

  it("dedupes entries when an idempotency key is reused", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("projects generic queue attachments to descriptor-only metadata before persistence", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const secret = "GENERIC_QUEUE_INLINE_SECRET";
      const widenedRef = {
        kind: "blob-sha256" as const,
        sha256: "a".repeat(64),
        mediaType: "text/plain",
        content: secret,
      };
      const payloads: QueuedSessionDeliveryPayload[] = [
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "descriptor-only event",
          attachments: [widenedRef],
        },
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "descriptor-only turn",
          messageId: "descriptor-only-turn",
          attachments: [widenedRef],
        },
      ];

      for (const payload of payloads) {
        const id = await enqueueSessionDelivery(payload, tempDir);
        await moveSessionDeliveryToFailed(id, tempDir);
        const row = readSessionQueueRow(tempDir, id);
        expect(row?.entry_json).not.toContain(secret);
        expect(JSON.parse(row?.entry_json ?? "{}")).toMatchObject({
          attachments: [
            {
              kind: "blob-sha256",
              sha256: "a".repeat(64),
              mediaType: "text/plain",
            },
          ],
        });
      }
    });
  });

  it("scrubs widened generic attachment metadata during pending recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const secret = "RECOVERED_GENERIC_QUEUE_SECRET";
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover descriptor metadata",
        },
        tempDir,
      );
      rewriteSessionQueueEntry(tempDir, id, (entry) => {
        entry.attachments = [
          {
            kind: "blob-sha256",
            sha256: "b".repeat(64),
            content: secret,
          },
        ];
      });

      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
      const row = readSessionQueueRow(tempDir, id);
      expect(row).toMatchObject({
        status: "failed",
        last_error: "invalid generic session delivery attachment metadata",
      });
      expect(row?.entry_json).not.toContain(secret);
    });
  });

  it("grants one initial-attempt lease and releases it for recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("reports a dead-letter conflict instead of claiming it as pending", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const payload = {
        kind: "agentTurn" as const,
        sessionKey: "agent:main:main",
        message: "generated image ready",
        messageId: "image:task-dead-letter:agent-loop",
        idempotencyKey: "image:task-dead-letter:agent-loop",
      };
      const first = await enqueueClaimedSessionDelivery(payload, 60_000, tempDir);
      await moveSessionDeliveryToFailed(first.id, tempDir);

      await expect(enqueueClaimedSessionDelivery(payload, 60_000, tempDir)).resolves.toEqual({
        id: first.id,
        claimed: false,
        status: "failed",
      });
    });
  });

  it("lets an explicit enqueue revive a failed idempotency key", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("never revives a failed permanent producer intent", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("atomically repairs unreadable pending JSON for an idempotent enqueue", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("canonicalizes post-compaction mount hints before durable enqueue", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueuePostCompactionDelegateDelivery(
        {
          sessionKey: "agent:main:main",
          delegate: {
            task: "use the durable snapshot",
            createdAt: 123,
            attachments: [{ name: "brief.md", content: "snapshot" }],
            attachAs: { mountPath: "  handoff/path  " },
          },
          sequence: 0,
        },
        tempDir,
      );

      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toMatchObject({
        kind: "postCompactionDelegate",
        attachAs: { mountPath: "handoff/path" },
      });
      await expect(
        enqueuePostCompactionDelegateDelivery(
          {
            sessionKey: "agent:main:main",
            delegate: {
              task: "reject unsafe mount",
              createdAt: 124,
              attachAs: { mountPath: "unsafe\npath" },
            },
            sequence: 1,
          },
          tempDir,
        ),
      ).rejects.toThrow("invalid postCompactionDelegate delivery payload: invalid shape");
    });
  });

  it("normalizes empty post-compaction attachments to absence", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueuePostCompactionDelegateDelivery(
        {
          sessionKey: "agent:main:main",
          delegate: {
            task: "continue without a snapshot",
            createdAt: 123,
            attachments: [],
            attachAs: { mountPath: "unused" },
          },
          sequence: 0,
        },
        tempDir,
      );

      const entry = await loadPendingSessionDelivery(id, tempDir);
      expect(entry).not.toHaveProperty("attachments");
      expect(entry).not.toHaveProperty("attachAs");
    });
  });

  it("rejects invalid post-compaction snapshot bytes before durable enqueue", async () => {
    const corruptions: Array<{
      name: string;
      attachments: Array<{ name: string; content: string; encoding?: "utf8" | "base64" }>;
    }> = [
      {
        name: "unsafe name",
        attachments: [{ name: "../escape", content: "snapshot" }],
      },
      {
        name: "invalid base64",
        attachments: [{ name: "brief.md", content: "not-base64!", encoding: "base64" }],
      },
      {
        name: "oversized content",
        attachments: [{ name: "brief.md", content: "x".repeat(1024 * 1024 + 1) }],
      },
    ];

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const [sequence, corruption] of corruptions.entries()) {
        await expect(
          enqueuePostCompactionDelegateDelivery(
            {
              sessionKey: "agent:main:main",
              delegate: {
                task: `reject ${corruption.name}`,
                createdAt: 600 + sequence,
                attachments: corruption.attachments,
              },
              sequence,
            },
            tempDir,
          ),
        ).rejects.toThrow("invalid postCompactionDelegate delivery payload: invalid shape");
      }
      await expect(loadPendingSessionDeliveries(tempDir)).resolves.toEqual([]);
    });
  });

  it("dead-letters invalid post-compaction JSON without retaining raw bytes", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueuePostCompactionDelegateDelivery(
        {
          sessionKey: "agent:main:main",
          delegate: { task: "recover valid snapshot", createdAt: 123 },
          sequence: 0,
        },
        tempDir,
      );
      const secret = "CORRUPT_QUEUE_JSON_SECRET";
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET entry_json = ?
          WHERE queue_name = 'session' AND id = ?`,
      ).run(`{"secret":"${secret}"`, id);

      await expect(loadPendingSessionDeliveries(tempDir)).resolves.toEqual([]);
      const row = readSessionQueueRow(tempDir, id);
      expect(row).toMatchObject({
        status: "failed",
        last_error: "invalid postCompactionDelegate delivery payload: invalid JSON",
      });
      expect(row?.entry_json).not.toContain(secret);
    });
  });

  it("dead-letters invalid generic JSON without retaining raw bytes", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover a generic event",
        },
        tempDir,
      );
      const secret = "CORRUPT_GENERIC_QUEUE_JSON_SECRET";
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET entry_json = ?
          WHERE queue_name = 'session' AND id = ?`,
      ).run(`{"attachments":[{"content":"${secret}"}]`, id);

      await expect(loadPendingSessionDeliveries(tempDir)).resolves.toEqual([]);
      const row = readSessionQueueRow(tempDir, id);
      expect(row).toMatchObject({
        status: "failed",
        last_error: "invalid generic session delivery payload: invalid JSON",
      });
      expect(row?.entry_json).not.toContain(secret);
    });
  });

  it("dead-letters post-compaction snapshots that fail byte-level attachment validation", async () => {
    const corruptions: Array<{
      name: string;
      attachments: Array<Record<string, unknown>>;
    }> = [
      {
        name: "unsafe name",
        attachments: [{ name: "../unsafe", content: "snapshot" }],
      },
      {
        name: "invalid base64",
        attachments: [{ name: "brief.md", content: "not-base64!", encoding: "base64" }],
      },
      {
        name: "oversized content",
        attachments: [{ name: "brief.md", content: "x".repeat(1024 * 1024 + 1) }],
      },
    ];

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const [sequence, corruption] of corruptions.entries()) {
        const secret = `QUEUE_ATTACHMENT_VALIDATION_SECRET_${sequence}`;
        const id = await enqueuePostCompactionDelegateDelivery(
          {
            sessionKey: "agent:main:main",
            delegate: {
              task: `recover ${corruption.name}`,
              createdAt: 700 + sequence,
              attachments: [{ name: "brief.md", content: secret }],
            },
            sequence,
          },
          tempDir,
        );
        rewriteSessionQueueEntry(tempDir, id, (entry) => {
          entry.attachments = corruption.attachments;
        });

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid postCompactionDelegate delivery payload: invalid shape",
        });
        expect(row?.entry_json).not.toContain(secret);
        expect(row?.entry_json).not.toContain("not-base64!");
      }
    });
  });

  it("dead-letters raw post-compaction snapshots when entry_kind is missing or stale", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const [sequence, entryKind] of [null, "agentTurn"].entries()) {
        const secret = `STALE_ENTRY_KIND_SECRET_${sequence}`;
        const id = await enqueuePostCompactionDelegateDelivery(
          {
            sessionKey: "agent:main:main",
            delegate: {
              task: "recover only matching post-compaction metadata",
              createdAt: 800 + sequence,
              attachments: [{ name: "brief.md", content: secret }],
            },
            sequence,
          },
          tempDir,
        );
        rewriteSessionQueueEntryKind(tempDir, id, entryKind);

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid postCompactionDelegate delivery payload: invalid shape",
        });
        expect(row?.entry_json).not.toContain(secret);
        expect(row?.entry_json).not.toContain("attachments");
        expect(row?.entry_json).not.toContain("task");
        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
      }
    });
  });

  it("dead-letters malformed post-compaction attachment members without retaining content", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const secret = "MALFORMED_QUEUE_ATTACHMENT_SECRET";
      const id = await enqueuePostCompactionDelegateDelivery(
        {
          sessionKey: "agent:main:main",
          delegate: {
            task: "recover attachment snapshot",
            createdAt: 123,
            attachments: [{ name: "brief.md", content: secret }],
          },
          sequence: 0,
        },
        tempDir,
      );
      const current = readSessionQueueRow(tempDir, id);
      const malformed = JSON.parse(current?.entry_json ?? "{}") as Record<string, unknown>;
      malformed.attachments = [{ name: "brief.md", content: secret, encoding: "hex" }];
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET entry_json = ?
          WHERE queue_name = 'session' AND id = ?`,
      ).run(JSON.stringify(malformed), id);

      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
      const row = readSessionQueueRow(tempDir, id);
      expect(row).toMatchObject({
        status: "failed",
        last_error: "invalid postCompactionDelegate delivery payload: invalid shape",
      });
      expect(row?.entry_json).not.toContain(secret);
    });
  });

  it("dead-letters post-compaction rows that violate live queue semantics", async () => {
    const corruptions: Array<{
      name: string;
      mutate: (entry: Record<string, unknown>, secret: string) => void;
    }> = [
      {
        name: "empty task",
        mutate: (entry) => {
          entry.task = "   ";
        },
      },
      {
        name: "contradictory targeting",
        mutate: (entry) => {
          entry.targetSessionKey = "agent:main:target";
          entry.fanoutMode = "all";
        },
      },
      {
        name: "invalid retry budget",
        mutate: (entry) => {
          entry.maxRetries = -1;
        },
      },
      {
        name: "unknown fields",
        mutate: (entry, secret) => {
          entry.untrusted = secret;
        },
      },
    ];

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const [sequence, corruption] of corruptions.entries()) {
        const secret = `CORRUPT_QUEUE_SECRET_${sequence}`;
        const id = await enqueuePostCompactionDelegateDelivery(
          {
            sessionKey: "agent:main:main",
            delegate: {
              task: `recover ${corruption.name}`,
              createdAt: 123 + sequence,
              attachments: [{ name: "brief.md", content: secret }],
            },
            sequence,
          },
          tempDir,
        );
        rewriteSessionQueueEntry(tempDir, id, (entry) => corruption.mutate(entry, secret));

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid postCompactionDelegate delivery payload: invalid shape",
        });
        if (!row) {
          throw new Error(`Expected failed session delivery row ${id}`);
        }
        expect(row.entry_json).not.toContain(secret);
        expect(JSON.parse(row.entry_json)).toEqual({
          id,
          enqueuedAt: expect.any(Number),
          retryCount: 0,
          lastError: "invalid postCompactionDelegate delivery payload: invalid shape",
        });
      }
    });
  });

  it("persists retry metadata and retains acked idempotency tombstones", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
