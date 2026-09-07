/**
 * Retained Gateway completion-handoff ownership for announce retries.
 *
 * When an announce gets a nonterminal gateway response (accepted / in_flight),
 * keep the idempotency key so a later retry rejoins that handoff instead of
 * steering into a successor requester run after the original handle settles.
 *
 * Retention is bound to the announce lifecycle: keep across retryable attempts,
 * release on terminal retirement (success, abandonment, permanent failure,
 * deadline expiry / give-up, intentional non-delivery) and when a
 * requester-settle batch retires without another delivery attempt.
 */
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
  buildRequesterSettleAnnounceId,
} from "../../announce-idempotency.js";
import { isActiveEmbeddedRunId } from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const retainedCompletionHandoffKeys = new Set<string>();

export function normalizeCompletionHandoffKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  return normalized || undefined;
}

export function retainCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.add(normalized);
  }
}

export function releaseCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.delete(normalized);
  }
}

/** Release retained ownership when announce delivery finally retires a child run. */
export function releaseAnnounceCompletionHandoffForChildRun(params: {
  childSessionKey: string;
  childRunId: string;
}): void {
  releaseCompletionHandoffKey(
    buildAnnounceIdempotencyKey(
      buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: params.childRunId,
      }),
    ),
  );
}

/** Attempt suffixes a settle wake may have retained (base + retry-1/2). */
const REQUESTER_SETTLE_ATTEMPT_KEY_COUNT = 3;

/** Release retained ownership for every attempt key a settle batch may have used. */
export function releaseAnnounceCompletionHandoffForRequesterSettleBatch(params: {
  requesterAgentId?: string;
  requesterSessionKey: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
}): void {
  if (params.batchRunIds.length === 0) {
    return;
  }
  for (let attemptIndex = 0; attemptIndex < REQUESTER_SETTLE_ATTEMPT_KEY_COUNT; attemptIndex += 1) {
    releaseCompletionHandoffKey(
      buildAnnounceIdempotencyKey(
        buildRequesterSettleAnnounceId({
          requesterAgentId: params.requesterAgentId,
          requesterSessionKey: params.requesterSessionKey,
          batchRunIds: params.batchRunIds,
          rearmGeneration: params.rearmGeneration,
          attemptIndex,
        }),
      ),
    );
  }
}

/**
 * Keep ownership across retryable attempts; release on every terminal outcome.
 */
export function settleCompletionHandoffRetention(
  key: string | undefined,
  result: SubagentAnnounceDeliveryResult,
): SubagentAnnounceDeliveryResult {
  if (result.disposition !== "retryable") {
    releaseCompletionHandoffKey(key);
  }
  return result;
}

export function clearRetainedCompletionHandoffKeysForTest(): void {
  retainedCompletionHandoffKeys.clear();
}

export function shouldJoinOriginalCompletionHandoff(key: string | undefined): boolean {
  const normalized = normalizeCompletionHandoffKey(key);
  if (!normalized) {
    return false;
  }
  // Prefer Gateway replay whenever we already own a pending handoff for this
  // key, or the original run is still the active embedded handle.
  return retainedCompletionHandoffKeys.has(normalized) || isActiveEmbeddedRunId(normalized);
}
