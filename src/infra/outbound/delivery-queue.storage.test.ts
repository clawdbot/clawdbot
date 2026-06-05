// Verifies SQLite-backed outbound queue storage, metadata, failure updates,
// recovery-state markers, and failed-entry moves.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  loadPendingDeliveries,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
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

  describe("enqueue + ack lifecycle", () => {
    it("creates and removes a queue entry", async () => {
      const id = await enqueueTextDelivery(
        {
          channel: "directchat",
          to: "+1555",
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

      await markDeliveryPlatformSendAttemptStarted(id, tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(typeof entry.platformSendStartedAt).toBe("number");
      expect((entry.platformSendStartedAt as number) > 0).toBe(true);
      expect(entry.recoveryState).toBe("send_attempt_started");
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
