// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  failPendingDelivery,
  loadPendingDelivery,
  loadPendingDeliveries,
  moveToFailed,
} from "./delivery-queue-storage.js";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const enqueueTextDelivery = (params: Parameters<typeof enqueueDelivery>[0], rootDir = tmpDir()) =>
    enqueueDelivery(params, rootDir);

  function readStatus(id: string): string | undefined {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() },
    });
    const row = db
      .prepare("SELECT status FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = ?")
      .get(id) as { status?: string } | undefined;
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
          mirror: {
            sessionKey: "agent:main:main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
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
      expect(entry.mirror).toEqual({
        sessionKey: "agent:main:main",
        text: "hello",
        mediaUrls: ["https://example.com/file.png"],
      });
      expect(entry.session).toEqual({
        key: "agent:main:main",
        agentId: "agent-main",
        requesterAccountId: "acct-1",
        requesterSenderId: "sender-1",
      });
      expect(entry.retryCount).toBe(0);
      expect(entry.payloads).toEqual([{ text: "hello" }]);

      await ackDelivery(id, tmpDir());
      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
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
    it("atomically writes the failed status and immutable reason into row and entry JSON", async () => {
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
            expectedStatus: "pending",
            lastError: "unsupported_enterprise_slack_delivery",
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "failed" });

      expect(await loadPendingDelivery(id, tmpDir())).toBeNull();
      expect(readStatus(id)).toBe("failed");
      expect(readQueuedEntry(tmpDir(), id).lastError).toBe("unsupported_enterprise_slack_delivery");
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
            expectedStatus: "pending",
            lastError: "unsupported_enterprise_slack_delivery",
            entry,
          },
          tmpDir(),
        ),
      ).resolves.toEqual({ status: "not_pending" });
      expect(readQueuedEntry(tmpDir(), id).lastError).toBeUndefined();
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed/ subdirectory", async () => {
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
      expect(readStatus(id)).toBe("failed");
    });

    it("does not remove failed entries when a stale ack arrives", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "workspace",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());
      await ackDelivery(id, tmpDir());

      expect(readStatus(id)).toBe("failed");
    });
  });

  describe("queue media custody", () => {
    it("can retain artifacts while an active recovery attempt owns them", async () => {
      const acked = await enqueueSpoolDelivery("0");

      await ackDelivery(acked.id, tmpDir(), { retainSpoolArtifacts: true });

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(0);
      await expect(fs.stat(acked.artifact)).resolves.toBeDefined();
    });

    it("releases artifacts after every terminal queue transition", async () => {
      const acked = await enqueueSpoolDelivery("1");
      await ackDelivery(acked.id, tmpDir());
      await expect(fs.stat(acked.artifact)).rejects.toThrow();

      const moved = await enqueueSpoolDelivery("2");
      await moveToFailed(moved.id, tmpDir());
      await expect(fs.stat(moved.artifact)).rejects.toThrow();

      const guarded = await enqueueSpoolDelivery("3");
      const entry = await loadPendingDelivery(guarded.id, tmpDir());
      if (!entry) {
        throw new Error("expected pending entry");
      }
      await failPendingDelivery(
        {
          id: guarded.id,
          expectedStatus: "pending",
          lastError: "terminal failure",
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
