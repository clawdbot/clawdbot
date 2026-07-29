// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Canonical staleness policy for staged/released post-compaction delegate work
 * (RFC §4.4).
 *
 * Every owner that can move staged work closer to a child — TaskFlow release,
 * startup recovery, the post-compaction release dispatcher, and queued delivery
 * retry — reads the TTL from here. Duplicating the arithmetic is what let a
 * released queue row outlive the staged row it came from.
 */

/** RFC §4.4 stale cutoff for staged post-compaction work. */
export const POST_COMPACTION_DELEGATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Work whose age is measured from when it was first armed. `firstArmedAt` is
 * authoritative; `createdAt` is the legacy fallback for rows staged before the
 * field existed, and an absent pair reads as freshly armed rather than ancient.
 */
export type PostCompactionArmedWork = {
  firstArmedAt?: number;
  createdAt?: number;
};

/**
 * RFC §4.4 drops work "older than the TTL", so the boundary is exclusive:
 * `ageMs === POST_COMPACTION_DELEGATE_TTL_MS` still releases and only
 * `ageMs > POST_COMPACTION_DELEGATE_TTL_MS` is terminal.
 */
export function classifyPostCompactionDelegateAge(
  work: PostCompactionArmedWork,
  now: number,
): { ageMs: number; stale: boolean } {
  const armedAt = work.firstArmedAt ?? work.createdAt ?? now;
  const ageMs = now - armedAt;
  return { ageMs, stale: ageMs > POST_COMPACTION_DELEGATE_TTL_MS };
}

/**
 * Terminal-row/diagnostic text for a stale drop. Deliberately carries only the
 * age so a stale rejection can never spill task prose or attachment bytes into
 * a blocked summary, log line, or queue diagnostic.
 */
export function formatPostCompactionStaleRejection(ageMs: number): string {
  return `Post-compaction delegate rejected as stale after ${ageMs}ms.`;
}
