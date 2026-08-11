/**
 * Subagent run liveness policy.
 *
 * Ages out stale unended runs while keeping recent/composed child links visible.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDurationMs } from "./subagent-run-timeout.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

type SubagentRunLivenessRecord = Pick<
  SubagentRunRecord,
  "createdAt" | "sessionStartedAt" | "runTimeoutSeconds"
> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
};

export const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

/** Return whether a subagent run has a finite execution end timestamp. */
export function hasSubagentRunEnded<T extends { execution: { endedAt?: number } }>(
  entry: T,
): entry is T & { execution: T["execution"] & { endedAt: number } } {
  return typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt);
}

function resolveStaleCutoffMs(
  entry: Pick<SubagentRunRecord, "runTimeoutSeconds">,
  defaultFloorMs = STALE_UNENDED_SUBAGENT_RUN_MS,
): number {
  // `defaultFloorMs` is the baseline cutoff applied when the run carries no
  // explicit timeout. The orphan-reap confidence gate passes a tunable
  // floor here; the per-run timeout-derived cutoff is always respected so a run
  // with an explicit long timeout is never aged out before that timeout + grace.
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs !== undefined) {
    return Math.max(defaultFloorMs, durationMs + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
  }
  return defaultFloorMs;
}

/** Return whether an unended subagent run is stale enough to hide as inactive. */
export function isStaleUnendedSubagentRun(
  entry: SubagentRunLivenessRecord,
  now = Date.now(),
): boolean {
  if (hasSubagentRunEnded(entry)) {
    return false;
  }
  return isUnendedRunStalePastCutoff(entry, now, STALE_UNENDED_SUBAGENT_RUN_MS);
}

function isUnendedRunStalePastCutoff(
  entry: SubagentRunLivenessRecord,
  now: number,
  defaultFloorMs: number,
): boolean {
  const startedAt = getSubagentSessionStartedAt(entry);
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS
  ) {
    return false;
  }
  return now - startedAt > resolveStaleCutoffMs(entry, defaultFloorMs);
}

/**
 * Three-state liveness verdict for the orphan-reap confidence gate.
 *
 * Collapses a child-session run record into the only distinction the reaper may
 * act on: are we CONFIDENT the parent run is terminal (reap-eligible), is it
 * plausibly still live (quiesce), or do we simply not know (quiesce)? The
 * asymmetric error cost is load-bearing : wrongly culling a busy seat is
 * unrecoverable, while parking a zombie is harmless — so anything short of
 * `confident-terminal` MUST resolve to a non-reap state.
 *
 * - `undefined` entry (no run record for the session) → `uncertain`: we cannot
 *   confirm the parent is gone, so never reap. A recovered or main-agent session
 *   with no child-run record lands here and is protected.
 * - explicit `endedAt` (markSubagentRunTerminated writes it synchronously on
 *   explicit termination, no lag) → `confident-terminal`.
 * - unended but aged past the (tunable) stale cutoff → `confident-terminal`: the
 *   driver died without marking, and only after the cutoff are we confident.
 * - unended within the stale window → `alive`: genuinely live, or racy-dead
 *   inside the grace — both quiesce, never reap.
 *
 * `staleCutoffMs` is the operator-tunable confidence-gate floor; the per-run
 * timeout-derived cutoff is always respected (see resolveStaleCutoffMs).
 */
export type SubagentRunLiveness = "alive" | "confident-terminal" | "uncertain";

export function classifySubagentRunLiveness(
  entry: SubagentRunLivenessRecord | undefined,
  options: { now?: number; staleCutoffMs?: number } = {},
): SubagentRunLiveness {
  if (!entry) {
    return "uncertain";
  }
  if (hasSubagentRunEnded(entry)) {
    return "confident-terminal";
  }
  const now = options.now ?? Date.now();
  const floorMs = options.staleCutoffMs ?? STALE_UNENDED_SUBAGENT_RUN_MS;
  if (isUnendedRunStalePastCutoff(entry, now, floorMs)) {
    return "confident-terminal";
  }
  return "alive";
}

/** Return whether a subagent run is still live and unended. */
export function isLiveUnendedSubagentRun(
  entry: SubagentRunLivenessRecord,
  now = Date.now(),
): boolean {
  return !hasSubagentRunEnded(entry) && !isStaleUnendedSubagentRun(entry, now);
}

function isRecentlyEndedSubagentRun(
  entry: { execution: Pick<SubagentRunRecord["execution"], "endedAt"> },
  now = Date.now(),
  recentMs = RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
): boolean {
  if (!hasSubagentRunEnded(entry)) {
    return false;
  }
  return now - entry.execution.endedAt <= recentMs;
}

/** Return whether a child-session link should still appear in subagent listings. */
export function shouldKeepSubagentRunChildLink(
  entry: SubagentRunLivenessRecord,
  options?: {
    activeDescendants?: number;
    now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  return (
    isLiveUnendedSubagentRun(entry, now) ||
    (options?.activeDescendants ?? 0) > 0 ||
    isRecentlyEndedSubagentRun(entry, now)
  );
}
