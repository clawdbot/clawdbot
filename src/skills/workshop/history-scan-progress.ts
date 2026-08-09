import {
  candidateOlderThanCursor,
  type SkillHistoryScanCandidate,
} from "./history-scan-candidates.js";
import { HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS } from "./history-scan-review-outcome.js";
import type { SkillHistoryScanDirection } from "./history-scan-state.js";
import type { SkillWorkshopProposalReviewProgress } from "./types.js";

export function resolveSkillHistoryScanHasMore(params: {
  direction: SkillHistoryScanDirection;
  oldestCursor?: { instanceId: string; updatedAtMs: number };
  candidates: readonly SkillHistoryScanCandidate[];
}): boolean {
  // A cursorless newer scan follows an empty first scan. Its candidates are
  // new work, not evidence that an older page remains.
  if (params.direction === "newer" && !params.oldestCursor) {
    return false;
  }
  const oldestCursor = params.oldestCursor;
  return oldestCursor
    ? params.candidates.some((candidate) => candidateOlderThanCursor(candidate, oldestCursor))
    : params.candidates.length > 0;
}

export function reconcileSkillHistoryScanProgress(params: {
  durableMutationCount: number;
  durableProposalIds: readonly string[];
}): SkillWorkshopProposalReviewProgress {
  // Proposal records are the recovery authority. The checkpoint can include a
  // failed reservation or miss a write that landed immediately before a crash.
  const proposalIds = [...new Set(params.durableProposalIds)];
  const remaining = Math.max(0, HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS - params.durableMutationCount);
  return {
    proposalIds,
    remaining,
    successfulMutations: params.durableMutationCount,
  };
}
