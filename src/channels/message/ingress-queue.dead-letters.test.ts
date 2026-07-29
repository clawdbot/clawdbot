// Dead-letter queue tests cover retained diagnostics, replay, and health counts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  countFailedChannelIngressQueueEntries,
  createChannelIngressQueue,
} from "./ingress-queue.js";

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-dead-letters-"));
  try {
    return await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("channel ingress dead letters", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("retains failed payload, metadata, and attempt history", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }, { source: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });

      await queue.enqueue(
        "event-1",
        { text: "recover me" },
        { metadata: { source: "webhook" }, receivedAt: 5, laneKey: "chat-1" },
      );
      const firstClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!firstClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.release(firstClaim, { lastError: "retryable", releasedAt: 20 });
      const finalClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!finalClaim) {
        throw new Error("Expected a reclaimed ingress event");
      }
      await queue.fail(finalClaim, { reason: "handler-error", message: "fatal", failedAt: 30 });

      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        {
          id: "event-1",
          channelId: "telegram",
          accountId: "ops",
          queueName: JSON.stringify(["telegram", "ops"]),
          payload: { text: "recover me" },
          metadata: { source: "webhook" },
          receivedAt: 5,
          updatedAt: 30,
          laneKey: "chat-1",
          attempts: 1,
          lastAttemptAt: 20,
          failedAt: 30,
          reason: "handler-error",
          message: "fatal",
        },
      ]);
    });
  });

  it("resubmits a failed event exactly once and refuses its completed tombstone", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }, { source: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      });
      if (!queue.resubmit) {
        throw new Error("Expected queue.resubmit");
      }

      await queue.enqueue(
        "event-1",
        { text: "once" },
        { metadata: { source: "webhook" }, receivedAt: 10, laneKey: "chat-1" },
      );
      const originalClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!originalClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(originalClaim, { reason: "handler-error", failedAt: 20 });

      await expect(queue.resubmit("event-1", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: {
          id: "event-1",
          payload: { text: "once" },
          metadata: { source: "webhook" },
          receivedAt: 30,
          laneKey: "chat-1",
          attempts: 0,
        },
        previous: { attempts: 0, failedAt: 20, reason: "handler-error" },
      });
      await expect(queue.resubmit("event-1", { resubmittedAt: 31 })).resolves.toEqual({
        kind: "active",
        status: "pending",
      });

      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
      await expect(queue.claimNext({ ownerId: "other-worker" })).resolves.toBeNull();
      if (!replay) {
        throw new Error("Expected the resubmitted event to be claimable");
      }
      expect(await queue.complete(replay, { completedAt: 40 })).toBe(true);
      await expect(queue.resubmit("event-1", { resubmittedAt: 50 })).resolves.toMatchObject({
        kind: "completed",
        record: { id: "event-1", completedAt: 40 },
      });
      await expect(queue.claimNext()).resolves.toBeNull();
    });
  });

  it("retains and resubmits a valid null payload", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<null>({
        channelId: "telegram",
        accountId: "null-payload",
        stateDir,
      });
      if (!queue.resubmit) {
        throw new Error("Expected queue.resubmit");
      }

      await queue.enqueue("event-null", null);
      const claim = await queue.claim("event-null", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });

      await expect(queue.listFailed?.()).resolves.toEqual([
        expect.objectContaining({ id: "event-null", payload: null }),
      ]);
      await expect(queue.resubmit("event-null", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { id: "event-null", payload: null, attempts: 0 },
      });
      await expect(queue.claimNext({ ownerId: "replay-worker" })).resolves.toMatchObject({
        id: "event-null",
        payload: null,
      });
    });
  });

  it("counts dead letters by channel account with their oldest failure", async () => {
    await withTempState(async (stateDir) => {
      const telegram = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });
      const line = createChannelIngressQueue<{ text: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      });
      for (const [queue, id, failedAt] of [
        [telegram, "tg-1", 20],
        [telegram, "tg-2", 30],
        [line, "line-1", 40],
      ] as const) {
        await queue.enqueue(id, { text: id });
        const claim = await queue.claim(id, { ownerId: "worker" });
        if (!claim) {
          throw new Error(`Expected ${id} to be claimed`);
        }
        await queue.fail(claim, { reason: "handler-error", failedAt });
      }

      expect(countFailedChannelIngressQueueEntries(stateDir)).toEqual([
        { channelId: "line", accountId: "default", count: 1, oldestFailedAt: 40 },
        { channelId: "telegram", accountId: "ops", count: 2, oldestFailedAt: 20 },
      ]);
    });
  });
});
