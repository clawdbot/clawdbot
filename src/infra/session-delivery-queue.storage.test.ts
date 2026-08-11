// Covers session delivery queue persistence state transitions.
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  completeSessionDelivery,
  enqueuePostCompactionDelegateDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
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
  ):
    | {
        status: string;
        entry_json: string;
        last_error: string | null;
        entry_kind: string | null;
        session_key: string | null;
        channel: string | null;
        target: string | null;
        account_id: string | null;
      }
    | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
    });
    return db
      .prepare(
        `SELECT status, entry_json, last_error,
                entry_kind, session_key, channel, target, account_id
           FROM delivery_queue_entries
          WHERE queue_name = 'session' AND id = ?`,
      )
      .get(id) as
      | {
          status: string;
          entry_json: string;
          last_error: string | null;
          entry_kind: string | null;
          session_key: string | null;
          channel: string | null;
          target: string | null;
          account_id: string | null;
        }
      | undefined;
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

  it("projects generic queue attachments to descriptor-only metadata before persistence", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      db.prepare(
        `UPDATE delivery_queue_entries
            SET entry_kind = 'systemEvent',
                session_key = 'agent:main:main',
                channel = 'discord',
                target = 'channel:private',
                account_id = 'private-account'
          WHERE queue_name = 'session' AND id = ?`,
      ).run(id);

      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
      const row = readSessionQueueRow(tempDir, id);
      expect(row).toMatchObject({
        status: "failed",
        last_error: "invalid generic session delivery attachment metadata",
        entry_kind: null,
        session_key: null,
        channel: null,
        target: null,
        account_id: null,
      });
      expect(row?.entry_json).not.toContain(secret);
    });
  });

  it("requires exact generic metadata kinds and strict generic payload shapes during recovery", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const corruptions = [
        {
          payload: {
            kind: "systemEvent" as const,
            sessionKey: "agent:main:main",
            text: "GENERIC_KIND_SYSTEM_TO_AGENT_SECRET",
          },
          mutate: (id: string) => rewriteSessionQueueEntryKind(tempDir, id, "agentTurn"),
          secret: "GENERIC_KIND_SYSTEM_TO_AGENT_SECRET",
        },
        {
          payload: {
            kind: "agentTurn" as const,
            sessionKey: "agent:main:main",
            message: "GENERIC_KIND_AGENT_TO_SYSTEM_SECRET",
            messageId: "generic-kind-agent-to-system",
          },
          mutate: (id: string) => rewriteSessionQueueEntryKind(tempDir, id, "systemEvent"),
          secret: "GENERIC_KIND_AGENT_TO_SYSTEM_SECRET",
        },
        {
          payload: {
            kind: "systemEvent" as const,
            sessionKey: "agent:main:main",
            text: "strict generic event",
          },
          mutate: (id: string) =>
            rewriteSessionQueueEntry(tempDir, id, (entry) => {
              entry.extra = "GENERIC_UNKNOWN_FIELD_SECRET";
            }),
          secret: "GENERIC_UNKNOWN_FIELD_SECRET",
        },
      ];

      for (const corruption of corruptions) {
        const id = await enqueueSessionDelivery(corruption.payload, tempDir);
        corruption.mutate(id);

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid generic session delivery payload: invalid shape",
        });
        expect(row?.entry_json).not.toContain(corruption.secret);
      }
    });
  });

  it("fails closed for untrusted trace context and malformed continuation triggers", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "untrusted metadata",
          messageId: "untrusted-metadata",
        },
        tempDir,
      );
      rewriteSessionQueueEntry(tempDir, id, (entry) => {
        entry.traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      });
      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toEqual(
        expect.not.objectContaining({ traceparent: expect.anything() }),
      );
      rewriteSessionQueueEntry(tempDir, id, (entry) => {
        entry.continuationTrigger = "operator-controlled";
      });
      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
      expect(readSessionQueueRow(tempDir, id)).toMatchObject({
        status: "failed",
        last_error: "invalid generic session delivery payload: invalid shape",
      });
    });
  });

  it("fails a managed delegate return whose durable receipt and projection disagree", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await expect(
        enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "managed return",
            expectedSessionId: "session-1",
            managedDelegateArtifactDelivery: {
              receipt: {
                kind: "delegate-artifact",
                dispatchId: "dispatch-1",
                recipientSessionKey: "agent:main:main",
                recipientSessionId: "session-1",
              },
              projection: {
                artifacts: [],
                arrivalContext: {
                  deliveryClass: "delegate result",
                  deliveryMode: "announced",
                  dispatchId: "dispatch-other",
                  producer: { sessionKey: "agent:main:child", runId: "run-1" },
                  completionId: "completion-1",
                  binding: {
                    recipientSessionKey: "agent:main:main",
                    recipientSessionId: "session-1",
                  },
                  dispatchAcceptedAt: 1,
                  completedAt: 2,
                  deliveredAt: 3,
                  policyVersion: 1,
                  availability: "available",
                },
              },
            },
          },
          tempDir,
        ),
      ).rejects.toThrow("invalid generic session delivery payload: invalid shape");
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

  it("reports a dead-letter conflict instead of claiming it as pending", async () => {
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

  it("persists only canonical relative post-compaction mount hints", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

      const invalidMountPaths = [
        "/absolute",
        "handoff/../outside",
        "handoff/./nested",
        "handoff//nested",
        "handoff/path/",
        "handoff:path",
        "unsafe\npath",
      ];
      for (const [index, mountPath] of invalidMountPaths.entries()) {
        await expect(
          enqueuePostCompactionDelegateDelivery(
            {
              sessionKey: "agent:main:main",
              delegate: {
                task: "reject unsafe mount",
                createdAt: 124 + index,
                attachments: [{ name: "brief.md", content: "snapshot" }],
                attachAs: { mountPath },
              },
              sequence: index + 1,
            },
            tempDir,
          ),
          mountPath,
        ).rejects.toThrow("invalid postCompactionDelegate delivery payload: invalid shape");
      }
      await expect(loadPendingSessionDeliveries(tempDir)).resolves.toHaveLength(1);
    });
  });

  it("rejects one-sided post-compaction source metadata before persistence", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const mismatchedMetadata = [
        { sourceFlowId: "flow-without-revision" },
        { sourceExpectedRevision: 7 },
      ];

      for (const [sequence, metadata] of mismatchedMetadata.entries()) {
        await expect(
          enqueueSessionDelivery(
            {
              kind: "postCompactionDelegate",
              sessionKey: "agent:main:main",
              task: "reject incomplete source metadata",
              createdAt: 900 + sequence,
              ...metadata,
            },
            tempDir,
          ),
        ).rejects.toThrow("invalid postCompactionDelegate delivery payload: invalid shape");
      }

      await expect(loadPendingSessionDeliveries(tempDir)).resolves.toEqual([]);
    });
  });

  it("dead-letters noncanonical recovered post-compaction mount hints and scrubs them", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const invalidMountPaths = [
        "/absolute",
        "handoff/../outside",
        "handoff/./nested",
        "handoff//nested",
        "handoff/path/",
        " handoff/path ",
        "handoff:path",
      ];

      for (const [sequence, mountPath] of invalidMountPaths.entries()) {
        const secret = `INVALID_RECOVERED_MOUNT_SECRET_${sequence}`;
        const id = await enqueuePostCompactionDelegateDelivery(
          {
            sessionKey: "agent:main:main",
            delegate: {
              task: "recover only a canonical mount",
              createdAt: 200 + sequence,
              attachments: [{ name: "brief.md", content: secret }],
              attachAs: { mountPath: "handoff/path" },
            },
            sequence,
          },
          tempDir,
        );
        rewriteSessionQueueEntry(tempDir, id, (entry) => {
          entry.attachAs = { mountPath };
        });

        await expect(loadPendingSessionDelivery(id, tempDir), mountPath).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid postCompactionDelegate delivery payload: invalid shape",
        });
        expect(row?.entry_json).not.toContain(secret);
        expect(row?.entry_json).not.toContain("attachAs");
        expect(row?.entry_json).not.toContain("attachments");
      }
    });
  });

  it("normalizes empty post-compaction attachments to absence", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("rejects oversized serialized snapshot metadata before queue persistence", async () => {
    const invalidDelegates = [
      {
        attachments: [{ name: "brief.bin", content: "Z g==", encoding: "base64" as const }],
      },
      {
        attachments: [{ name: "brief.txt", content: "snapshot", mimeType: "m".repeat(257) }],
      },
      {
        attachments: [{ name: "brief.txt", content: "snapshot" }],
        attachAs: { mountPath: "a".repeat(1025) },
      },
    ];

    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const [sequence, invalid] of invalidDelegates.entries()) {
        await expect(
          enqueuePostCompactionDelegateDelivery(
            {
              sessionKey: "agent:main:main",
              delegate: {
                task: "reject serialized attachment expansion",
                createdAt: 650 + sequence,
                ...invalid,
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
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

  it("accepts generic descriptor attachment refs without widening them to inline input", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const legacySha256 = "legacy-nonhex-descriptor";
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "descriptor-only event",
          attachments: [{ kind: "blob-sha256", sha256: legacySha256, mediaType: "text/plain" }],
        },
        tempDir,
      );

      await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toMatchObject({
        kind: "systemEvent",
        attachments: [{ kind: "blob-sha256", sha256: legacySha256 }],
      });
    });
  });

  it("dead-letters empty or widened generic blob descriptors before returning them", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const corruptions = [
        { kind: "blob-sha256", sha256: "", mediaType: "text/plain" },
        {
          kind: "blob-sha256",
          sha256: "legacy-nonhex-descriptor",
          mediaType: "text/plain",
          extra: "UNKNOWN_BLOB_DESCRIPTOR_FIELD",
        },
      ];
      for (const [index, attachment] of corruptions.entries()) {
        const id = await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: `malformed descriptor seed ${index}`,
          },
          tempDir,
        );
        const current = readSessionQueueRow(tempDir, id);
        const corrupted = JSON.parse(current?.entry_json ?? "{}") as Record<string, unknown>;
        corrupted.attachments = [attachment];
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        });
        db.prepare(
          `UPDATE delivery_queue_entries
            SET entry_json = ?
          WHERE queue_name = 'session' AND id = ?`,
        ).run(JSON.stringify(corrupted), id);

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid generic session delivery attachment metadata",
        });
        expect(row?.entry_json).not.toContain("attachments");
        expect(row?.entry_json).not.toContain("UNKNOWN_BLOB_DESCRIPTOR_FIELD");
      }
    });
  });

  it("dead-letters seeded generic inline attachments before they can be returned", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      for (const kind of ["systemEvent", "agentTurn"] as const) {
        const id =
          kind === "systemEvent"
            ? await enqueueSessionDelivery(
                {
                  kind,
                  sessionKey: "agent:main:main",
                  text: "generic inline attachment seed",
                },
                tempDir,
              )
            : await enqueueSessionDelivery(
                {
                  kind,
                  sessionKey: "agent:main:main",
                  message: "generic inline attachment seed",
                  messageId: `generic-inline-${kind}`,
                },
                tempDir,
              );
        const secret = `GENERIC_${kind.toUpperCase()}_INLINE_ATTACHMENT_SECRET`;
        const current = readSessionQueueRow(tempDir, id);
        const corrupted = JSON.parse(current?.entry_json ?? "{}") as Record<string, unknown>;
        corrupted.attachments = [{ name: "brief.md", content: secret }];
        const { db } = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
        });
        db.prepare(
          `UPDATE delivery_queue_entries
              SET entry_json = ?
            WHERE queue_name = 'session' AND id = ?`,
        ).run(JSON.stringify(corrupted), id);

        await expect(loadPendingSessionDelivery(id, tempDir)).resolves.toBeNull();
        await expect(loadPendingSessionDeliveries(tempDir)).resolves.not.toContainEqual(
          expect.objectContaining({ id }),
        );
        const row = readSessionQueueRow(tempDir, id);
        expect(row).toMatchObject({
          status: "failed",
          last_error: "invalid generic session delivery attachment metadata",
        });
        expect(row?.entry_json).not.toContain(secret);
        expect(row?.last_error).not.toContain(secret);
      }
    });
  });

  it("dead-letters malformed post-compaction attachment members without retaining content", async () => {
    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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

    await withTestDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
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
});
