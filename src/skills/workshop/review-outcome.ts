import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";

export const HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS = 3;

export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const message =
    result.meta.error?.message.trim() ||
    result.meta.failureSignal?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    errorPayload?.text?.trim();
  if (message || errorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}

export function resolveSkillHistoryScanReviewOutcome(params: {
  failedMutations?: number;
  ideasFound: number;
  proposalMutationBudgetRemaining: number;
  successfulMutations: number;
}): number {
  if ((params.failedMutations ?? 0) > 0) {
    throw new Error("Historical skill scan has failed proposal mutations to retry.");
  }
  const attemptedMutations =
    HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS - params.proposalMutationBudgetRemaining;
  if (params.successfulMutations > attemptedMutations) {
    throw new Error("Historical skill scan proposal accounting is inconsistent.");
  }
  return params.ideasFound;
}
