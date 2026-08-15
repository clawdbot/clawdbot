import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { toErrorObject } from "../../infra/errors.js";

export const HISTORY_SCAN_MAX_PROPOSAL_MUTATIONS = 3;

export function resolveSkillHistoryScanRunFailure(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): Error | undefined {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const message =
    result.meta.error?.message.trim() ||
    result.meta.failureSignal?.message.trim() ||
    (result.meta.aborted ? "Historical skill scan model run aborted." : undefined) ||
    errorPayload?.text?.trim();
  return message || errorPayload
    ? new Error(message || "Historical skill scan model run failed.")
    : undefined;
}

export function resolveSkillHistoryScanReviewOutcome(params: {
  failedMutations?: number;
  ideasFound: number;
  proposalMutationBudgetRemaining: number;
  successfulMutations: number;
  runError?: unknown;
}): number {
  if (params.runError !== undefined) {
    throw toErrorObject(params.runError, "Historical skill scan model run failed.");
  }
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
