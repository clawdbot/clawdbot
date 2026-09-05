import type { SessionTranscriptInstance } from "../../config/sessions/session-accessor.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../routing/session-key.js";

const HISTORY_SCAN_BLOCKED_SEGMENTS = new Set([
  "active-memory",
  "commitments",
  "heartbeat",
  "hook",
  "memory",
  "skill-workshop-history-scan",
  "skill-workshop-review",
]);

export function isSkillHistoryScanSessionEligible(
  summary: Pick<SessionTranscriptInstance, "acpOwned" | "entry" | "provenanceKnown" | "sessionKey">,
): boolean {
  const { acpOwned, entry, provenanceKnown, sessionKey } = summary;
  if (
    !provenanceKnown ||
    acpOwned ||
    !sessionKey.trim() ||
    !entry.sessionId?.trim() ||
    entry.spawnedBy ||
    (entry.spawnDepth ?? 0) > 0 ||
    entry.pluginOwnerId ||
    entry.hookExternalContentSource ||
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  ) {
    return false;
  }
  const segments = sessionKey.toLowerCase().split(":");
  return !segments.some((segment) => HISTORY_SCAN_BLOCKED_SEGMENTS.has(segment));
}

export function compareSkillHistoryScanCandidates(
  left: { instanceId: string; updatedAtMs: number },
  right: { instanceId: string; updatedAtMs: number },
): number {
  const timestampOrder = right.updatedAtMs - left.updatedAtMs;
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}
