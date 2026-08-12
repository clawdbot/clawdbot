export type DeliveryQueueCompletionRetention =
  | "permanent"
  | Readonly<{
      idPrefix: string;
      maxAgeMs: number;
      maxEntries: number;
    }>;

/** Persisted queue entry fields common to all delivery queue payloads. */
export type DeliveryQueueEntryState = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  availableAt?: number;
  /** Only explicit reusable producers retain a platform-send ownership lease. */
  requiresProducerClaim?: boolean;
  producerClaimId?: string;
  /** Durable delivery-call count reserved before invoking the provider path. */
  attemptCount?: number;
  completionRetention?: DeliveryQueueCompletionRetention;
  acknowledgedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** UUID fencing one platform attempt even when clock timestamps collide. */
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
};
