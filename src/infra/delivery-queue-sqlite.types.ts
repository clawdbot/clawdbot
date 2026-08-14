export type DeliveryQueueCompletionRetention =
  | "permanent"
  | Readonly<{
      idPrefix: string;
      maxAgeMs: number;
      maxEntries: number;
    }>;

export type DeliveryQueueFailureRetention = "none" | DeliveryQueueCompletionRetention;

export type DeliveryQueueTerminalFence =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "permanent" }>
  | Readonly<{
      kind: "producer-bounded";
      idPrefix: string;
      maxAgeMs: number;
      maxEntries: number;
    }>;

export type DeliveryQueueTerminalReason =
  | "admission_rejected"
  | "legacy_unknown"
  | "owner_dismissed"
  | "owner_expired"
  | "owner_settled"
  | "permanent_rejection"
  | "retry_exhausted";

/** Owner-authored terminal facts kept after sensitive failed-row detail is removed. */
export type DeliveryQueueTerminalPolicy = Readonly<{
  version: 1;
  detail: "full" | "compacted";
  replay: "safe" | "ambiguous" | "owner-managed";
  fence: DeliveryQueueTerminalFence;
  reason: DeliveryQueueTerminalReason;
  payload: "present" | "none";
  /** Provider cleanup, then exact media removal, then no remaining exact cleanup. */
  cleanup: "pending" | "media_pending" | "complete";
  evidence?:
    | "delivery_started"
    | "legacy_unknown"
    | "owner_managed"
    | "pre_side_effect"
    | "send_attempt_started"
    | "settled"
    | "unknown_after_send";
  settlementOutcome?: "moved-to-failed" | "recovered";
  owner?: "durable_delivery" | "subagent_completion";
  detailExpiresAt?: number;
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
  /** Failure-only idempotency fence; successful acknowledgement ignores this field. */
  failureRetention?: DeliveryQueueFailureRetention;
  acknowledgedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** UUID fencing one platform attempt even when clock timestamps collide. */
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
  terminalPolicy?: DeliveryQueueTerminalPolicy;
};
