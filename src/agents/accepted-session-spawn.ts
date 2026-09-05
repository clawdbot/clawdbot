/** Normalizes accepted child-session spawn results from loose tool payloads. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Helpers for recognizing accepted session-spawn tool results.
export type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
  /** True only when this child owns a terminal completion for its requester. */
  expectsCompletionMessage?: boolean;
};

/** Normalize a tool result that accepted a child session spawn. */
export function normalizeAcceptedSessionSpawnResult(result: unknown): AcceptedSessionSpawn | null {
  const details = asOptionalRecord(asOptionalRecord(result)?.details);
  if (!details || details.status !== "accepted") {
    return null;
  }
  const runId = normalizeOptionalString(details.runId);
  const childSessionKey = normalizeOptionalString(details.childSessionKey);
  if (!runId || !childSessionKey) {
    return null;
  }
  return {
    runId,
    childSessionKey,
    expectsCompletionMessage: details.expectsCompletionMessage === true,
  };
}

/** Return true when a collection contains at least one accepted child spawn. */
export function hasAcceptedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return Boolean(acceptedSessionSpawns?.length);
}

/** Return true when an accepted child owns the requester's terminal completion. */
export function hasCompletionMessageSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return acceptedSessionSpawns?.some((spawn) => spawn.expectsCompletionMessage === true) === true;
}
