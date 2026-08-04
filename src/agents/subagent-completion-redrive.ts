/**
 * Compaction-unlock redrive for suspended subagent completions.
 *
 * When a compaction holds the session write-lock past its acquire timeout, a
 * completed subagent's announce can exhaust its retries and become suspended
 * (`delivery.status === "suspended"`). `resumeSubagentRun` refuses suspended
 * entries, so the result is silently dropped. After compaction releases the
 * lock, this module redrives the requester's still-deliverable suspended
 * completions through the shared `retrySubagentCompletionDelivery` path.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type RedriveCompletionsDeps = {
  runs: ReadonlyMap<string, SubagentRunRecord>;
  retryDelivery: (taskId: string) => Promise<{ ok: boolean; reason?: string }>;
};

/** Returns whether a run is eligible for a compaction-unlock redrive. */
function isRedriveCandidate(entry: SubagentRunRecord, requesterSessionKey: string): boolean {
  if (entry.requesterSessionKey !== requesterSessionKey) {
    return false;
  }
  if (entry.expectsCompletionMessage !== true) {
    return false;
  }
  const delivery = entry.delivery;
  if (!delivery || delivery.status !== "suspended") {
    return false;
  }
  // Only lock/announce exhaustion is recoverable; permanent failures stay put.
  if (delivery.suspendedReason !== "retry-limit" && delivery.suspendedReason !== "expiry") {
    return false;
  }
  // Frozen result must survive the pending reset (captured or fallback text).
  const hasFrozenResultText = Boolean(entry.completion?.resultText?.trim());
  const hasFrozenFallbackText = Boolean(entry.completion?.fallbackResultText?.trim());
  if (!hasFrozenResultText && !hasFrozenFallbackText) {
    return false;
  }
  return true;
}

/** Selects suspended completions owned by the requester that can be redriven. */
export function selectRedriveCandidates(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  requesterSessionKey: string,
): SubagentRunRecord[] {
  const candidates: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (isRedriveCandidate(entry, requesterSessionKey)) {
      candidates.push(entry);
    }
  }
  return candidates;
}

/**
 * Redrives suspended completions for one requester after its compaction
 * unlocks, delegating each redrive to the shared delivery retry path so task
 * registry and queue state stay consistent.
 */
export async function redriveSuspendedSubagentCompletions(
  requesterSessionKey: string,
  deps: RedriveCompletionsDeps,
): Promise<{ matched: number; redriven: number }> {
  const normalizedRequesterSessionKey = requesterSessionKey.trim();
  if (!normalizedRequesterSessionKey) {
    return { matched: 0, redriven: 0 };
  }
  const candidates = selectRedriveCandidates(deps.runs, normalizedRequesterSessionKey);
  let redriven = 0;
  for (const entry of candidates) {
    const result = await deps.retryDelivery(entry.taskRunId ?? entry.runId);
    if (result.ok) {
      redriven += 1;
    }
  }
  return { matched: candidates.length, redriven };
}
