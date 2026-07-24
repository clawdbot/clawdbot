import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import type { ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export function buildNodeNonInteractiveApprovalRequiredResult(params: {
  command: string;
  cwd?: string;
}): AgentToolResult<ExecToolDetails> {
  const text = `Exec denied (approval_required): ${params.command}`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      failureKind: "approval_required",
      durationMs: 0,
      aggregated: text,
      timedOut: false,
      cwd: params.cwd,
    },
  };
}

export function resolveNodeAutoReviewReason(params: {
  inlineEvalHit: InterpreterInlineEvalHit | null;
  hostSecurity: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied: boolean;
}): ExecAutoReviewInput["reason"] {
  if (params.inlineEvalHit !== null) {
    return "strict-inline-eval";
  }
  if (
    params.hostSecurity === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied) &&
    !params.durableApprovalSatisfied
  ) {
    return "allowlist-miss";
  }
  return "approval-required";
}

function execSecurityFloorRank(security: ExecSecurity): number {
  switch (security) {
    case "full":
      return 0;
    case "allowlist":
      return 1;
    case "deny":
      return 2;
  }
  throw new Error("Unsupported exec security floor");
}

export function nodePolicyBlocksAutoReview(params: {
  hostSecurity: ExecSecurity;
  nodeApprovalPolicyKnown: boolean;
  nodeSecurity?: ExecSecurity;
  nodeAsk?: "off" | "on-miss" | "always";
}): boolean {
  return (
    !params.nodeApprovalPolicyKnown ||
    params.nodeAsk === "always" ||
    (params.nodeSecurity !== undefined &&
      execSecurityFloorRank(params.nodeSecurity) > execSecurityFloorRank(params.hostSecurity))
  );
}
