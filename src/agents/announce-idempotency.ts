/**
 * Stable announce identifiers for child-run completion messages.
 * Versioned keys let future formats coexist with persisted v1 delivery records.
 */
type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
};

const ANNOUNCE_IDEMPOTENCY_KEY_PREFIX = "announce:";

/** Build the persisted announce id for a child session/run pair. */
export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

/** Build the idempotency key used by announce delivery storage. */
export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `${ANNOUNCE_IDEMPOTENCY_KEY_PREFIX}${announceId}`;
}

/** True when a gateway run id belongs to an announce delivery turn. */
export function isAnnounceRunId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith(ANNOUNCE_IDEMPOTENCY_KEY_PREFIX);
}

/** Build the announce id for a requester-settle wake delivery attempt. */
export function buildRequesterSettleAnnounceId(params: {
  requesterAgentId?: string;
  requesterSessionKey: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  attemptIndex?: number;
}): string {
  const wakeKeyBase = [
    `requester-settle:${params.requesterAgentId ?? "unknown"}:${params.requesterSessionKey}:${[...params.batchRunIds].toSorted().join(",")}`,
    params.rearmGeneration === undefined ? undefined : `yield-${params.rearmGeneration}`,
  ]
    .filter(Boolean)
    .join(":");
  const attemptIndex = params.attemptIndex ?? 0;
  return attemptIndex === 0 ? wakeKeyBase : `${wakeKeyBase}:retry-${attemptIndex}`;
}
