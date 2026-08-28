import { describe, expect, it, vi } from "vitest";
import {
  claimDeliveryQueueEntryPlatformSend,
  createInitialDeliveryProducerClaim,
  dispatchDeliveryQueueEntryPlatformSend,
  promoteDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
  transitionOwnedDeliveryQueueEntry,
} from "./delivery-queue-sqlite-claim.js";
import {
  deleteDeliveryQueueEntry,
  loadDeliveryQueueEntry,
  reserveDeliveryQueueEntryAttempt,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";

describe("delivery queue SQLite dispatch ownership", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  const queueName = "test-dispatch-owner";

  it.each(["producer_claimed", "send_attempt_started", "unknown_after_send"] as const)(
    "preserves the retry budget when a %s claim expires before reservation",
    (recoveryState) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-28T10:00:00.000Z"));
        const initialClaim = createInitialDeliveryProducerClaim();
        const params = { queueName, id: "expiring-reservation", stateDir: tmpDir() };
        const claimed = { ...params, claimId: initialClaim.producerClaimId };
        const reservation = {
          ...params,
          maxAttempts: 2,
          expectedPlatformSendAttemptId: claimed.claimId,
        };
        upsertDeliveryQueueEntry({
          ...params,
          entry: { id: params.id, enqueuedAt: Date.now(), retryCount: 0, ...initialClaim },
        });
        if (recoveryState !== "producer_claimed") {
          expect(dispatchDeliveryQueueEntryPlatformSend(claimed)).toBe(true);
          if (recoveryState === "unknown_after_send") {
            updateDeliveryQueueEntry(queueName, params.id, params.stateDir, (entry) => ({
              ...entry,
              recoveryState,
            }));
          }
          expect(promoteDeliveryQueueEntryPlatformSend(claimed)).toBe(false);
        }
        expect(reserveDeliveryQueueEntryAttempt(reservation)).toEqual({
          status: "reserved",
          attemptCount: 1,
        });

        vi.setSystemTime(initialClaim.availableAt);
        expect(() => reserveDeliveryQueueEntryAttempt(reservation)).toThrow("claim was lost");
        expect(loadDeliveryQueueEntry(queueName, params.id, params.stateDir)?.attemptCount).toBe(1);
        expect(renewDeliveryQueueEntryPlatformSendLease(claimed)).toBeUndefined();
        expect(dispatchDeliveryQueueEntryPlatformSend(claimed)).toBe(false);
        if (recoveryState === "producer_claimed") {
          const replacement = claimDeliveryQueueEntryPlatformSend(params);
          expect(replacement).toEqual(expect.any(String));
          expect(() => reserveDeliveryQueueEntryAttempt(reservation)).toThrow("claim was lost");
          expect(
            reserveDeliveryQueueEntryAttempt({
              ...reservation,
              expectedPlatformSendAttemptId: replacement,
            }),
          ).toEqual({ status: "reserved", attemptCount: 2 });
        } else {
          // Expiry forbids more work, but the exact owner may settle an observed outcome.
          expect(
            transitionOwnedDeliveryQueueEntry(
              { ...params, platformSendAttemptId: claimed.claimId },
              () => deleteDeliveryQueueEntry(queueName, params.id, params.stateDir),
            ),
          ).toBe(true);
          expect(loadDeliveryQueueEntry(queueName, params.id, params.stateDir)).toBeNull();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reserves unclaimed rows and non-renewable platform attempts without adding a lease", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-28T10:00:00.000Z"));
      const params = { queueName, id: "unleased-reservation", stateDir: tmpDir() };
      upsertDeliveryQueueEntry({
        ...params,
        entry: { id: params.id, enqueuedAt: Date.now(), retryCount: 0 },
      });
      expect(reserveDeliveryQueueEntryAttempt({ ...params, maxAttempts: 2 })).toEqual({
        status: "reserved",
        attemptCount: 1,
      });
      const claimId = claimDeliveryQueueEntryPlatformSend(params);
      if (!claimId) {
        throw new Error("test invariant: unclaimed delivery must acquire a producer");
      }
      const claimed = { ...params, claimId };
      expect(dispatchDeliveryQueueEntryPlatformSend(claimed)).toBe(true);
      vi.advanceTimersByTime(30_001);
      expect(
        reserveDeliveryQueueEntryAttempt({
          ...params,
          maxAttempts: 2,
          expectedPlatformSendAttemptId: claimId,
        }),
      ).toEqual({ status: "reserved", attemptCount: 2 });
      expect(renewDeliveryQueueEntryPlatformSendLease(claimed)).toBeUndefined();
      expect(dispatchDeliveryQueueEntryPlatformSend(claimed)).toBe(true);
      expect(
        loadDeliveryQueueEntry(queueName, params.id, params.stateDir)?.availableAt,
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

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
