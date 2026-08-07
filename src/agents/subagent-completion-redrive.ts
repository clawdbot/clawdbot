/**
 * Compaction-unlock redrive for suspended subagent completions.
 *
 * When a compaction holds the session write-lock past its acquire timeout, a
 * completed subagent's announce can exhaust its retry window and become
 * suspended (`delivery.status === "suspended"` with an `expiry` reason).
 * `resumeSubagentRun` refuses suspended entries, so the result is silently
 * dropped. After compaction releases the lock, this module redrives the
 * requester's still-deliverable suspended completions that were suspended
 * inside the compaction's own lock-hold window, delegating each redrive to the
 * shared `retrySubagentCompletionDelivery` path.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Window a compaction held the requester session write-lock. Only completions
 * suspended inside this window are attributed to that specific lock hold;
 * older suspensions keep their own cause and are left untouched.
 */
export type CompactionLockWindow = {
  heldFrom: number;
  releasedAt: number;
};

/**
 * Announces that give up while the lock is held exhaust their delivery window,
 * so their suspension is recorded with an `expiry` reason. A suspension that
 * fired after the lock was already released (channel rejection, explicit
 * non-delivery) must not be revived here.
 *
 * The grace absorbs the async give-up path (`finalizeResumedAnnounceGiveUpInBackground`),
 * which may stamp `suspendedAt` a moment after the lock release. It must stay
 * well below the suspended retention (7 days) so genuinely old suspensions are
 * never attributed to the current compaction.
 */
export const COMPACTION_REDRIVE_WINDOW_GRACE_MS = 60_000;

export type RedriveCompletionsDeps = {
  runs: ReadonlyMap<string, SubagentRunRecord>;
  /** Retries one run's delivery. Receives the run id (taskRunId ?? runId) and
   * the implementation resolves it to the owning task before delivering. */
  retryDelivery: (runId: string) => Promise<{ ok: boolean; reason?: string }>;
};

/** Returns whether a run is eligible for a compaction-unlock redrive. */
function isRedriveCandidate(
  entry: SubagentRunRecord,
  requesterSessionKey: string,
  lockWindow: CompactionLockWindow,
): boolean {
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
  // Lock/announce exhaustion is the only recoverable suspension; permanent
  // failures stay put. `retry-limit` is never written by the lifecycle.
  if (delivery.suspendedReason !== "expiry") {
    return false;
  }
  // Bind the recovery to the compaction that actually held the lock: only
  // completions suspended inside its hold window are attributed to it.
  const suspendedAt = delivery.suspendedAt;
  if (typeof suspendedAt !== "number") {
    return false;
  }
  if (suspendedAt < lockWindow.heldFrom) {
    return false;
  }
  if (suspendedAt > lockWindow.releasedAt + COMPACTION_REDRIVE_WINDOW_GRACE_MS) {
    return false;
  }
  // Frozen result must survive the pending reset (captured or fallback text).
  const hasFrozenResultText = Boolean(entry.completion?.resultText?.trim());
  const hasFrozenFallbackText = Boolean(entry.completion?.fallbackResultText?.trim());
  return hasFrozenResultText || hasFrozenFallbackText;
}

/** Selects suspended completions owned by the requester that can be redriven. */
export function selectRedriveCandidates(
  runs: ReadonlyMap<string, SubagentRunRecord>,
  requesterSessionKey: string,
  lockWindow: CompactionLockWindow,
): SubagentRunRecord[] {
  const candidates: SubagentRunRecord[] = [];
  for (const entry of runs.values()) {
    if (isRedriveCandidate(entry, requesterSessionKey, lockWindow)) {
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
  lockWindow: CompactionLockWindow,
): Promise<{ matched: number; redriven: number }> {
  const normalizedRequesterSessionKey = requesterSessionKey.trim();
  if (!normalizedRequesterSessionKey) {
    return { matched: 0, redriven: 0 };
  }
  const candidates = selectRedriveCandidates(deps.runs, normalizedRequesterSessionKey, lockWindow);
  let redriven = 0;
  for (const entry of candidates) {
    const result = await deps.retryDelivery(entry.taskRunId ?? entry.runId);
    if (result.ok) {
      redriven += 1;
    }
  }
  return { matched: candidates.length, redriven };
}
