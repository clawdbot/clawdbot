import { describe, expect, it, vi } from "vitest";
import {
  claimDeliveryQueueEntryPlatformSend,
  dispatchDeliveryQueueEntryPlatformSend,
} from "./delivery-queue-sqlite-claim.js";
import { loadDeliveryQueueEntry, upsertDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";

describe("delivery queue SQLite dispatch ownership", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-dispatch-owner";

  it("atomically promotes dispatch ownership and rejects expired or replaced claims", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"));
      const stateDir = tmpDir();
      const id = "cron-direct-delivery:v1:dispatch-owner";
      upsertDeliveryQueueEntry({
        queueName,
        entry: {
          id,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: {
            idPrefix: "cron-direct-delivery:v1:",
            maxAgeMs: 24 * 60 * 60_000,
            maxEntries: 2,
          },
          requiresProducerClaim: true,
        },
        stateDir,
      });

      const expiredClaimId = claimDeliveryQueueEntryPlatformSend({ queueName, id, stateDir });
      if (!expiredClaimId) {
        throw new Error("test invariant: the first producer claim must be available");
      }
      vi.advanceTimersByTime(30_001);
      expect(
        dispatchDeliveryQueueEntryPlatformSend({
          queueName,
          id,
          claimId: expiredClaimId,
          stateDir,
        }),
      ).toBe(false);

      const claimId = claimDeliveryQueueEntryPlatformSend({ queueName, id, stateDir });
      if (!claimId) {
        throw new Error("test invariant: the replacement producer claim must be available");
      }
      expect(
        dispatchDeliveryQueueEntryPlatformSend({
          queueName,
          id,
          claimId: expiredClaimId,
          stateDir,
        }),
      ).toBe(false);
      expect(
        dispatchDeliveryQueueEntryPlatformSend({
          queueName,
          id,
          claimId,
          stateDir,
          route: { replyToId: "thread-1" },
        }),
      ).toBe(true);
      expect(loadDeliveryQueueEntry(queueName, id, stateDir)).toMatchObject({
        recoveryState: "send_attempt_started",
        platformSendAttemptId: claimId,
        platformSendStartedAt: Date.now(),
        effectiveReplyToId: "thread-1",
        availableAt: Date.now() + 30_000,
      });
      expect(loadDeliveryQueueEntry(queueName, id, stateDir)?.producerClaimId).toBeUndefined();

      vi.advanceTimersByTime(30_001);
      expect(dispatchDeliveryQueueEntryPlatformSend({ queueName, id, claimId, stateDir })).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
