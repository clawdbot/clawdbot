// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { updateDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { renewDeliveryPlatformSendLease } from "./delivery-queue-platform-lease.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  enqueueDelivery,
  enqueueDeliveryOnce,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  failPendingDelivery,
  loadPendingDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
  reserveDeliveryAttempt,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  function readStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
      .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as { status?: string } | undefined;
    return row?.status;
  }

  async function enqueueSpoolDelivery(suffix: string) {
    const artifact = path.join(
      tmpDir(),
      "delivery-queue-media",
      `00000000-0000-4000-8000-00000000000${suffix}.ogg`,
    );
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "audio-bytes");
    const id = await enqueueTextDelivery({
      channel: "directchat",
      to: "+1",
      payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
    });
    return { artifact, id };
  }

  describe("enqueue + ack lifecycle", () => {
    it("fences stale same-millisecond terminal mutations without releasing newer owner media", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
        const stateDir = tmpDir();
        const id = "cron-direct-delivery:v1:fenced-stale-terminal-media";
        const artifact = path.join(
          stateDir,
          "delivery-queue-media",
          "00000000-0000-4000-8000-000000000090.ogg",
        );
        await fs.mkdir(path.dirname(artifact), { recursive: true });
        await fs.writeFile(artifact, "newer owner still needs these bytes");
        await enqueueDeliveryOnce(
          {
            channel: "directchat",
            to: "+1555",
            payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
            completionRetention: {
              idPrefix: "cron-direct-delivery:v1:",
              maxAgeMs: 24 * 60 * 60_000,
              maxEntries: 2_000,
            },
          },
          id,
          stateDir,
        );
        const unclaimedSnapshot = await loadPendingDelivery(id, stateDir);
        if (!unclaimedSnapshot) {
          throw new Error("test invariant: the unclaimed bounded row must be readable");
        }
        const firstAttemptId = await claimDeliveryPlatformSendAttempt(id, stateDir);
        if (!firstAttemptId) {
          throw new Error("test invariant: first platform owner must claim the durable row");
        }
        const lostClaim = `Delivery platform claim was lost: ${id}`;
        // Admission snapshots taken before ownership must CAS the unclaimed
        // state; a producer that claimed meanwhile retains its media and row.
        await expect(
          ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: null }),
        ).rejects.toThrow(lostClaim);
        await expect(moveToFailed(id, stateDir, null)).rejects.toThrow(lostClaim);
        await expect(
          failPendingDelivery(
            {
              id,
              entry: unclaimedSnapshot,
            },
            stateDir,
          ),
        ).resolves.toEqual({ status: "not_pending" });
        expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
        await markDeliveryPlatformSendAttemptStarted(
          id,
          stateDir,
          { replyToId: null },
          firstAttemptId,
        );
        const sameStartedAt = Date.now();
        const secondAttemptId = await claimDeliveryPlatformSendAttempt(
          id,
          stateDir,
          sameStartedAt,
          firstAttemptId,
        );
        if (!secondAttemptId) {
          throw new Error("test invariant: reconciled replacement must claim the durable row");
        }
        await markDeliveryPlatformSendAttemptStarted(
          id,
          stateDir,
          { replyToId: null },
          secondAttemptId,
        );

        await expect(
          ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: firstAttemptId }),
        ).rejects.toThrow(lostClaim);
        await expect(failDelivery(id, "stale failure", stateDir, firstAttemptId)).rejects.toThrow(
          lostClaim,
        );
        await expect(
          failDeliveryBeforePlatformSend(id, "stale pre-send", stateDir, firstAttemptId),
        ).rejects.toThrow(lostClaim);
        await expect(
          failDeliveryAfterPlatformSend(id, "stale post-send", stateDir, firstAttemptId),
        ).rejects.toThrow(lostClaim);
        await expect(
          markDeliveryPlatformOutcomeUnknown(id, stateDir, firstAttemptId),
        ).rejects.toThrow(lostClaim);
        await expect(
          markDeliveryPlatformSendDispatched(id, stateDir, { replyToId: null }, firstAttemptId),
        ).rejects.toThrow(lostClaim);
        await expect(moveToFailed(id, stateDir, firstAttemptId)).rejects.toThrow(lostClaim);
        await expect(reserveDeliveryAttempt(id, 5, stateDir, firstAttemptId)).rejects.toThrow(
          lostClaim,
        );
        expect(await fs.readFile(artifact, "utf8")).toBe("newer owner still needs these bytes");
        expect(await loadPendingDelivery(id, stateDir)).toMatchObject({
          recoveryState: "send_attempt_started",
          platformSendAttemptId: secondAttemptId,
          platformSendStartedAt: sameStartedAt,
        });
        expect(readStatus(id)).toBe("pending");

        await ackDelivery(id, stateDir, { expectedPlatformSendAttemptId: secondAttemptId });
        expect(readStatus(id)).toBe("completed");
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("persists a producer-specific retry budget", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "retry-budget" }],
        maxRetries: 45,
      });

      expect(readQueuedEntry(tmpDir(), id).maxRetries).toBe(45);
    });

    it("projects process-local hook metadata out before JSON custody", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        preparedBatch: {
          schemaVersion: 1,
          sourcePayloadCount: 1,
          entries: [
            {
              sourceIndex: 0,
              status: "suppressed",
              reason: "cancelled_by_message_sending_hook",
              hookEffect: {
                cancelReason: "owned elsewhere",
                metadata: { nonJsonValue: 1n },
              },
            },
          ],
        },
      });

      expect(readQueuedEntry(tmpDir(), id).preparedBatch).toEqual({
        schemaVersion: 1,
        sourcePayloadCount: 1,
        entries: [
          {
            sourceIndex: 0,
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
          },
        ],
      });
    });

    it("canonicalizes duplicate singular and plural media before recording fan-out", async () => {
      const mediaUrl = "https://example.com/same.png";
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "caption", mediaUrl, mediaUrls: [mediaUrl] }],
      });

      const entry = readQueuedEntry(tmpDir(), id) as unknown as QueuedDelivery;
      expect(acceptedPreparedOutboundEntries(entry.preparedBatch)[0]?.preparedMediaCount).toBe(1);
    });

    it("atomically reserves delivery attempts up to the producer budget", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1555",
        payloads: [{ text: "attempt-budget" }],
        maxRetries: 2,
      });

      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "reserved",
        attemptCount: 2,
      });
      await expect(reserveDeliveryAttempt(id, 2, tmpDir())).resolves.toEqual({
        status: "exhausted",
        attemptCount: 2,
      });
      expect(readQueuedEntry(tmpDir(), id).attemptCount).toBe(2);
    });

    it("creates and removes a queue entry", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "directchat",
          to: "+1555",
          queuePolicy: "required",
          requireUnknownSendReconciliation: true,
          payloads: [{ text: "hello" }],
          renderedBatchPlan: {
            payloadCount: 1,
            textCount: 1,
            mediaCount: 0,
            voiceCount: 0,
            presentationCount: 0,
            interactiveCount: 0,
            channelDataCount: 0,
            items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
          },
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          gatewayClientScopes: ["operator.write"],
          preparedMessageId: "prepared-message-1",
          mirror: {
            sessionKey: "agent:main:main",
            expectedSessionId: "session-main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
            idempotencyKey: "channel-final:message-1",
            deliveryMirror: {
              kind: "channel-final",
              sourceMessageId: "message-1",
            },
          },
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
          },
        },
        tmpDir(),
      );
      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.id).toBe(id);
      expect(entry.channel).toBe("directchat");
      expect(entry.to).toBe("+1555");
      expect(entry.queuePolicy).toBe("required");
      expect(entry.requireUnknownSendReconciliation).toBe(true);
      expect(entry.renderedBatchPlan).toEqual({
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
      });
      expect(entry.bestEffort).toBe(true);
      expect(entry.gifPlayback).toBe(true);
      expect(entry.silent).toBe(true);
      expect(entry.gatewayClientScopes).toEqual(["operator.write"]);
      expect(entry.preparedMessageId).toBe("prepared-message-1");
      expect(entry.mirror).toEqual({
        sessionKey: "agent:main:main",
        expectedSessionId: "session-main",
        text: "hello",
        mediaUrls: ["https://example.com/file.png"],
        idempotencyKey: "channel-final:message-1",
        deliveryMirror: {
          kind: "channel-final",
          sourceMessageId: "message-1",
        },
      });
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
      });
      expect(entry.retryCount).toBe(0);
      expect(
        acceptedPreparedOutboundEntries((entry as unknown as QueuedDelivery).preparedBatch).map(
          (prepared) => prepared.payload,
        ),
      ).toEqual([{ text: "hello" }]);

      await ackDelivery(id, tmpDir());
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
    });

    it("does not replace an existing stable queue intent", async () => {
      const first = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "first" }],
          deliveryCompletion: {
            kind: "conversation",
            agentId: "main",
            operationId: "operation-stable",
          },
        },
        "operation-stable",
        tmpDir(),
      );
      const repeated = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "replacement" }],
        },
        "operation-stable",
        tmpDir(),
      );

      expect(first).toEqual({ id: "operation-stable", created: true });
      expect(repeated).toEqual({ id: "operation-stable", created: false });
      expect(readQueuedEntry(tmpDir(), "operation-stable")).toMatchObject({
        preparedBatch: {
          entries: [expect.objectContaining({ payload: { text: "first" }, status: "accepted" })],
        },
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-stable",
        },
      });
    });

    it("keeps permanent completion ownership after ack", async () => {
      const id = "restart-sentinel-notice:agent:main:main:123";
      await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "restart complete" }],
          completionRetention: "permanent",
        },
        id,
        tmpDir(),
      );

      await ackDelivery(id, tmpDir());
      const repeated = await enqueueDeliveryOnce(
        {
          channel: "directchat",
          to: "+1555",
          payloads: [{ text: "must not replay" }],
          completionRetention: "permanent",
        },
        id,
        tmpDir(),
      );

      expect(repeated).toEqual({ id, created: false });
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      expect(readStatus(id)).toBe("completed");
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir())).resolves.toBeUndefined();
    });

    it("removes acked entries from pending recovery", async () => {
      const id = await enqueueTextDelivery({
        channel: "directchat",
        to: "+1",
        payloads: [{ text: "ack-test" }],
      });

      await ackDelivery(id, tmpDir());

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readStatus(id)).toBeUndefined();
    });
  });

  describe("failDelivery", () => {
    it("marks entries as send-attempt-started before platform I/O", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir(), {
        replyToId: "1782584644.377229",
      });

      const entry = readQueuedEntry(tmpDir(), id);
      expect(typeof entry.platformSendStartedAt).toBe("number");
      expect((entry.platformSendStartedAt as number) > 0).toBe(true);
      expect(entry.recoveryState).toBe("send_attempt_started");
      expect(entry.effectiveReplyToId).toBe("1782584644.377229");
      expect(entry.retryCount).toBe(0);
    });

    it("marks entries as unknown-after-send after platform I/O returns", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(typeof entry.platformSendStartedAt).toBe("number");
      expect((entry.platformSendStartedAt as number) > 0).toBe(true);
      expect(entry.recoveryState).toBe("unknown_after_send");
      expect(entry.retryCount).toBe(0);
    });

    it("preserves and renews the exact explicit owner after an ambiguous platform outcome", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-02T10:00:00.000Z"));
        const stateDir = tmpDir();
        const id = "cron-direct-delivery:v1:unknown-owner-lease";
        await enqueueDeliveryOnce(
          {
            channel: "forum",
            to: "123",
            payloads: [{ text: "test" }],
            completionRetention: {
              idPrefix: "cron-direct-delivery:v1:",
              maxAgeMs: 24 * 60 * 60_000,
              maxEntries: 2_000,
            },
            requiresProducerClaim: true,
          },
          id,
          stateDir,
        );
        const claimId = await claimDeliveryPlatformSendAttempt(id, stateDir);
        if (!claimId) {
          throw new Error("test invariant: explicit producer must own the stable row");
        }
        await markDeliveryPlatformSendAttemptStarted(id, stateDir, undefined, claimId);
        const started = readQueuedEntry(stateDir, id);
        const originalExpiry = started.availableAt;
        vi.setSystemTime(Date.now() + 1_000);

        await markDeliveryPlatformOutcomeUnknown(id, stateDir, claimId);

        expect(readQueuedEntry(stateDir, id)).toMatchObject({
          recoveryState: "unknown_after_send",
          platformSendAttemptId: claimId,
          availableAt: originalExpiry,
        });
        await expect(renewDeliveryPlatformSendLease(id, stateDir, claimId)).resolves.toBe(
          Date.now() + 30_000,
        );
        expect(readQueuedEntry(stateDir, id).availableAt).toBe(Date.now() + 30_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("refreshes the attempt timestamp immediately before provider I/O", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
        vi.setSystemTime(9_000);
        await markDeliveryPlatformSendDispatched(id, tmpDir());
      } finally {
        vi.useRealTimers();
      }

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.platformSendStartedAt).toBe(9_000);
      expect(entry.recoveryState).toBe("send_attempt_started");
    });

    it("keeps ambiguous post-send evidence across a later unclaimed batch dispatch", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());
      await markDeliveryPlatformOutcomeUnknown(id, tmpDir());
      await markDeliveryPlatformSendDispatched(id, tmpDir());

      // Downgrading to send_attempt_started would let recovery replay the whole
      // batch as not_sent and duplicate the payload that already reached the platform.
      expect(readQueuedEntry(tmpDir(), id).recoveryState).toBe("unknown_after_send");
    });

    it("increments retryCount, records attempt time, and sets lastError", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir(),
      );

      await failDelivery(id, "connection refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(typeof entry.lastAttemptAt).toBe("number");
      expect((entry.lastAttemptAt as number) > 0).toBe(true);
      expect(entry.lastError).toBe("connection refused");
    });

    it("releases a settled live owner while retaining retryable custody", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
        requiresProducerClaim: true,
      });
      const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      expect(claimId).toEqual(expect.any(String));

      await failDelivery(id, "provider failed", tmpDir(), claimId);

      expect(readQueuedEntry(tmpDir(), id)).toMatchObject({
        retryCount: 1,
        lastError: "provider failed",
      });
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("availableAt");
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("producerClaimId");
      expect(readQueuedEntry(tmpDir(), id)).not.toHaveProperty("recoveryState");
    });

    it("keeps post-send failure evidence while recording the retry failure", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      });

      await failDeliveryAfterPlatformSend(id, "state update failed", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(entry.lastError).toBe("state update failed");
      expect(entry.recoveryState).toBe("unknown_after_send");
      expect(typeof entry.platformSendStartedAt).toBe("number");
    });

    it("atomically records a pre-send failure without retaining send evidence", async () => {
      const id = await enqueueTextDelivery({
        channel: "forum",
        to: "123",
        payloads: [{ text: "test" }],
      });
      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());

      await failDeliveryBeforePlatformSend(id, "connect refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(entry.lastError).toBe("connect refused");
      expect(entry.recoveryState).toBeUndefined();
      expect(entry.platformSendStartedAt).toBeUndefined();
    });
  });

  describe("failPendingDelivery", () => {
    it("deletes a rejected random delivery without retaining private detail", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        accountId: "enterprise",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }

      await expect(
        failPendingDelivery(
          {
            id,
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "failed" });

      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
      expect(readStatus(id)).toBeUndefined();
    });

    it("deletes a rejected random delivery under its transient live claim", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        payloads: [{ text: "private live payload" }],
      });
      const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
      if (!claimId) {
        throw new Error("test invariant: random live delivery must acquire its transient claim");
      }
      const claimed = await loadPendingDelivery(id, tmpDir());
      if (!claimed) {
        throw new Error("test invariant: claimed random delivery must remain pending");
      }

      await expect(failPendingDelivery({ id, entry: claimed }, tmpDir())).resolves.toEqual({
        status: "failed",
      });

      expect(readStatus(id)).toBeUndefined();
    });

    it("terminalizes a rejected stable row under its exact crash claim", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const artifact = path.join(
          tmpDir(),
          "delivery-queue-media",
          "00000000-0000-4000-8000-000000000091.ogg",
        );
        await fs.mkdir(path.dirname(artifact), { recursive: true });
        await fs.writeFile(artifact, "private rejected media");
        const id = "stable-rejected-after-crash-claim";
        await enqueueDeliveryOnce(
          {
            channel: "directchat",
            to: "+1555",
            payloads: [{ mediaUrl: artifact, audioAsVoice: true }],
            requiresProducerClaim: true,
          },
          id,
          tmpDir(),
        );
        const claimId = await claimDeliveryPlatformSendAttempt(id, tmpDir());
        if (!claimId) {
          throw new Error("test invariant: stable rejection must own a producer claim");
        }
        vi.setSystemTime(60_000);
        const claimed = await loadPendingDelivery(id, tmpDir());
        if (!claimed) {
          throw new Error("test invariant: claimed delivery must remain pending");
        }

        await expect(failPendingDelivery({ id, entry: claimed }, tmpDir())).resolves.toEqual({
          status: "failed",
        });

        expect(readStatus(id)).toBe("failed");
        expect(readQueuedEntry(tmpDir(), id)).toEqual({
          id,
          enqueuedAt: 60_000,
          failedAt: 60_000,
          retryCount: 0,
          completionRetention: "permanent",
          recoveryState: "completed_permanent",
        });
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns a typed no-op when a status race already moved the row", async () => {
      const id = await enqueueTextDelivery({
        channel: "slack",
        to: "C123",
        payloads: [{ text: "blocked" }],
      });
      const entry = await loadPendingDelivery(id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await moveToFailed(id, tmpDir());

      await expect(
        failPendingDelivery(
          {
            id,
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(readStatus(id)).toBeUndefined();
    });
  });

  describe("moveToFailed", () => {
    it("deletes a failed random delivery", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      expect(readStatus(id)).toBeUndefined();
    });

    it("retains a minimal stable fence that later producers cannot replace", async () => {
      const id = "stable-failed-delivery";
      await enqueueDeliveryOnce(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "private stable payload" }],
        },
        id,
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());
      await ackDelivery(id, tmpDir());

      expect(readStatus(id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id)).toEqual({
        id,
        enqueuedAt: expect.any(Number),
        failedAt: expect.any(Number),
        retryCount: 0,
        completionRetention: "permanent",
        recoveryState: "completed_permanent",
      });
      await expect(
        enqueueDeliveryOnce(
          { channel: "workspace", to: "#general", payloads: [{ text: "replacement" }] },
          id,
          tmpDir(),
        ),
      ).resolves.toEqual({ id, created: false });
    });
  });

  describe("queue media custody", () => {
    it("can retain artifacts while an active recovery attempt owns them", async () => {
      const acked = await enqueueSpoolDelivery("0");

      await ackDelivery(acked.id, tmpDir(), { retainSpoolArtifacts: true });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      await expect(fs.stat(acked.artifact)).resolves.toBeDefined();
    });

    it("releases artifacts after ack and guarded failure transitions", async () => {
      const acked = await enqueueSpoolDelivery("1");
      await ackDelivery(acked.id, tmpDir());
      await expect(fs.stat(acked.artifact)).rejects.toThrow();

      const guarded = await enqueueSpoolDelivery("3");
      const entry = await loadPendingDelivery(guarded.id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await failPendingDelivery(
        {
          id: guarded.id,
          entry,
        },
        tmpDir(),
      );
      await expect(fs.stat(guarded.artifact)).rejects.toThrow();
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array for an empty state database", async () => {
      expect(await loadPendingDeliveries(path.join(tmpDir(), "no-such-dir"))).toStrictEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueTextDelivery({ channel: "directchat", to: "+1", payloads: [{ text: "a" }] });
      await enqueueTextDelivery({ channel: "forum", to: "2", payloads: [{ text: "b" }] });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    });

    it.each([
      ["first", { source: "implicit", replyToId: "legacy-root", mode: "first" }],
      ["batched", { source: "implicit", replyToId: "legacy-root", mode: "first" }],
      ["all", { source: "implicit", replyToId: "legacy-root", mode: "all" }],
      ["off", undefined],
    ] as const)(
      "normalizes legacy %s reply fields at the storage boundary",
      async (mode, reply) => {
        const id = await enqueueTextDelivery({
          channel: "forum",
          to: "2",
          payloads: [{ text: "reply" }],
        });
        updateDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, tmpDir(), (entry) => ({
          ...entry,
          replyToId: "legacy-root",
          replyToMode: mode,
        }));

        const loaded = await loadPendingDelivery(id, tmpDir());
        expect(loaded?.reply).toEqual(reply);
        expect(loaded).not.toHaveProperty("replyToId");
        expect(loaded).not.toHaveProperty("replyToMode");
      },
    );

    it("persists gateway caller scopes for replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "2",
          payloads: [{ text: "b" }],
          gatewayClientScopes: ["operator.write"],
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.gatewayClientScopes).toEqual(["operator.write"]);
    });

    it("persists session context for recovery replay", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "forum",
          to: "2",
          payloads: [{ text: "b" }],
          session: {
            key: "agent:main:main",
            agentId: "agent-main",
            requesterAccountId: "acct-1",
            requesterSenderId: "sender-1",
            requesterSenderName: "Sender One",
            requesterSenderUsername: "sender.one",
            requesterSenderE164: "+15551234567",
          },
        },
        tmpDir(),
      );

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
        requesterSenderName: "Sender One",
        requesterSenderUsername: "sender.one",
        requesterSenderE164: "+15551234567",
      });
    });
  });
});
