import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type DeliveryQueueCompletionRetention =
  | "permanent"
  | Readonly<{ idPrefix: string; maxAgeMs: number; maxEntries: number }>;

/** Parse only the shipped completion-retention shape for one exact producer ID. */
export function parseDeliveryQueueCompletionRetention(
  value: unknown,
  id: string,
): DeliveryQueueCompletionRetention | undefined {
  if (value === "permanent") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const retention = value as Record<string, unknown>;
  const idPrefix = typeof retention.idPrefix === "string" ? retention.idPrefix : "";
  const maxAgeMs = asPositiveSafeInteger(retention.maxAgeMs);
  const maxEntries = asPositiveSafeInteger(retention.maxEntries);
  if (!idPrefix || !id.startsWith(idPrefix) || maxAgeMs === undefined || maxEntries === undefined) {
    return undefined;
  }
  return { idPrefix, maxAgeMs, maxEntries };
}

type DeliveryQueueFailureFacts = Partial<
  Record<
    | keyof DeliveryQueueEntryState
    | "deliveryCompletion"
    | "deliveryStartedAt"
    | "failureRetention"
    | "settlementOutcome"
    | "terminalPolicy",
    unknown
  >
>;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Recover only authored or shipped producer ownership from a failed entry. */
export function inferDeliveryQueueFailureRetention(
  entry: DeliveryQueueFailureFacts,
  id: string,
  queueName?: string,
  legacyAmbiguousSendEvidence = false,
): DeliveryQueueCompletionRetention | undefined {
  const explicit =
    parseDeliveryQueueCompletionRetention(entry.completionRetention, id) ??
    parseDeliveryQueueCompletionRetention(entry.failureRetention, id);
  if (explicit) {
    return explicit;
  }
  const fence = asNullableRecord(asNullableRecord(entry.terminalPolicy)?.fence);
  if (fence?.kind === "none") {
    return undefined;
  }
  const fenced =
    fence?.kind === "permanent" ? "permanent" : parseDeliveryQueueCompletionRetention(fence, id);
  if (fenced) {
    return fenced;
  }
  const durable =
    queueName === "outbound-preparing-v1" ||
    queueName === "outbound-legacy-preparing-v1" ||
    queueName === "outbound-prepared-migration-v1" ||
    entry.retainOnFailure === true ||
    asNullableRecord(entry.deliveryCompletion) !== null ||
    (queueName === "session" && finite(entry.availableAt));
  const ambiguous =
    legacyAmbiguousSendEvidence &&
    ((typeof entry.platformSendAttemptId === "string" && entry.platformSendAttemptId.length > 0) ||
      finite(entry.platformSendStartedAt) ||
      entry.recoveryState === "send_attempt_started" ||
      entry.recoveryState === "unknown_after_send" ||
      (queueName === "session" &&
        (finite(entry.deliveryStartedAt) ||
          (typeof entry.settlementOutcome === "string" && entry.settlementOutcome.length > 0) ||
          finite(entry.acknowledgedAt))));
  return durable || ambiguous ? "permanent" : undefined;
}

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
  /** Failure-only ownership fence; successful acknowledgement ignores this field. */
  retainOnFailure?: true;
  acknowledgedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** UUID fencing one platform attempt even when clock timestamps collide. */
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
};

/** Strip a terminal queue row to the producer policy needed for admission. */
export function projectDeliveryQueueTerminalEntry(
  entry: Pick<DeliveryQueueEntryState, "id" | "retryCount">,
  terminalAt: number,
  terminal: "completed" | "failed",
  completionRetention?: DeliveryQueueCompletionRetention,
): DeliveryQueueEntryState {
  const retryCount =
    Number.isSafeInteger(entry.retryCount) && entry.retryCount >= 0 ? entry.retryCount : 0;
  const recoveryState =
    completionRetention === "permanent"
      ? "completed_permanent"
      : completionRetention
        ? "completed_bounded"
        : undefined;
  return {
    id: entry.id,
    enqueuedAt: terminalAt,
    retryCount,
    ...(terminal === "completed" ? { acknowledgedAt: terminalAt } : { failedAt: terminalAt }),
    ...(completionRetention ? { completionRetention } : {}),
    ...(recoveryState ? { recoveryState } : {}),
  };
}
