type DeliveryQueueCompletionRetention =
  | "permanent"
  | Readonly<{
      idPrefix: string;
      maxAgeMs: number;
      maxEntries: number;
    }>;

/** Indexed metadata extracted from queue payloads for diagnostics and recovery. */
export type DeliveryQueueRowMetadata = {
  entryKind?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
};

/** Persisted queue entry fields common to all delivery queue payloads. */
type DeliveryQueueEntryState = {
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

export type DeliveryQueueSqliteRow = {
  id: string;
  entry_json: string;
  entry_kind?: string | null;
  enqueued_at: number | bigint;
  retry_count: number | bigint;
  last_attempt_at: number | bigint | null;
  last_error: string | null;
  platform_send_started_at: number | bigint | null;
  recovery_state: string | null;
};

type CorruptDeliveryQueueEntry = {
  id: string;
  entryKind?: string;
  enqueuedAt: number;
  retryCount: number;
};

// `entryJson` is the authoritative persisted text. Callers that dead-letter a
// row compare against it directly, because a corrupt row has no decoded value
// to re-serialize and a scrubbed terminal payload never round-trips.
export type DeliveryQueueEntryLoadResult =
  | { status: "loaded"; entry: DeliveryQueueEntryState; entryKind?: string; entryJson: string }
  | { status: "corrupt"; entry: CorruptDeliveryQueueEntry; entryJson: string };

export function inflateDeliveryQueueEntry(
  row: DeliveryQueueSqliteRow,
): DeliveryQueueEntryState | null {
  let parsed: DeliveryQueueEntryState;
  try {
    // SAFETY: entry_json is only ever produced by this codec's own encoder.
    parsed = JSON.parse(row.entry_json) as DeliveryQueueEntryState;
  } catch {
    return null;
  }

  return {
    ...parsed,
    id: row.id,
    enqueuedAt: Number(row.enqueued_at),
    retryCount: Number(row.retry_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
    ...(row.last_error == null ? {} : { lastError: row.last_error }),
    ...(row.platform_send_started_at == null
      ? {}
      : { platformSendStartedAt: Number(row.platform_send_started_at) }),
    ...(row.recovery_state == null ? {} : { recoveryState: row.recovery_state }),
  };
}

export function inflateDeliveryQueueEntryResult(
  row: DeliveryQueueSqliteRow,
): DeliveryQueueEntryLoadResult {
  const entry = inflateDeliveryQueueEntry(row);
  if (entry) {
    return {
      status: "loaded",
      entry,
      ...(row.entry_kind ? { entryKind: row.entry_kind } : {}),
      entryJson: row.entry_json,
    };
  }
  return {
    status: "corrupt",
    entry: {
      id: row.id,
      ...(row.entry_kind ? { entryKind: row.entry_kind } : {}),
      enqueuedAt: Number(row.enqueued_at),
      retryCount: Number(row.retry_count),
    },
    entryJson: row.entry_json,
  };
}
