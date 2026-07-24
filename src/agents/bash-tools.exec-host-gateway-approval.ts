import type { AllowAlwaysPersistenceDecision, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";

export function hasGatewayAllowlistMiss(params: {
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): boolean {
  return (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  );
}

export function resolveGatewayAutoReviewReason(params: {
  requiresInlineEvalApproval: boolean;
  requiresHeredocApproval: boolean;
  requiresAllowlistPlanApproval: boolean;
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): ExecAutoReviewInput["reason"] {
  if (params.requiresInlineEvalApproval) {
    return "strict-inline-eval";
  }
  if (params.requiresHeredocApproval) {
    return "heredoc";
  }
  if (params.requiresAllowlistPlanApproval) {
    return "execution-plan-miss";
  }
  if (
    hasGatewayAllowlistMiss({
      hostSecurity: params.hostSecurity,
      analysisOk: params.analysisOk,
      allowlistSatisfied: params.allowlistSatisfied,
      durableApprovalSatisfied: params.durableApprovalSatisfied,
    })
  ) {
    return "allowlist-miss";
  }
  return "approval-required";
}

function createOneShotAllowAlwaysDecision(): AllowAlwaysPersistenceDecision {
  return { kind: "one-shot", reasons: ["no-reusable-pattern"] };
}

export function resolveGatewayEffectiveAllowAlwaysPersistence(params: {
  allowAlwaysPersistence: AllowAlwaysPersistenceDecision;
  requiresAllowlistPlanApproval: boolean;
  requiresDenylistApproval: boolean;
}): AllowAlwaysPersistenceDecision {
  if (params.requiresDenylistApproval) {
    return createOneShotAllowAlwaysDecision();
  }
  if (!params.requiresAllowlistPlanApproval) {
    return params.allowAlwaysPersistence;
  }
  if (params.allowAlwaysPersistence.kind !== "patterns") {
    return params.allowAlwaysPersistence;
  }
  return createOneShotAllowAlwaysDecision();
}
