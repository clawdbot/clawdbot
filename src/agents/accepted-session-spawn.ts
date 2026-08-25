/** Normalizes accepted child-session spawn results from loose tool payloads. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

// Helpers for recognizing accepted session-spawn tool results.
export type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
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
  return { runId, childSessionKey };
}

/** Return true when a collection contains at least one accepted child spawn. */
export function hasAcceptedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return Boolean(acceptedSessionSpawns?.length);
}
