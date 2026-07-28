import type { InterpreterInlineEvalHit } from "../infra/command-analysis/inline-eval.js";
import type { ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";
import type { sendExecApprovalFollowupResult } from "./bash-tools.exec-host-shared.js";

type SendExecApprovalFollowupResult = typeof sendExecApprovalFollowupResult;

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
  // Remote policy may be stricter; local auto-review cannot bypass that floor.
  return (
    !params.nodeApprovalPolicyKnown ||
    params.nodeAsk === "always" ||
    (params.nodeSecurity !== undefined &&
      execSecurityFloorRank(params.nodeSecurity) > execSecurityFloorRank(params.hostSecurity))
  );
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

export function createNodeApprovalRequestFailureFollowup(params: {
  send: SendExecApprovalFollowupResult;
  target: Parameters<SendExecApprovalFollowupResult>[0];
  nodeId: string;
  approvalId: string;
  command: string;
  signal?: AbortSignal;
}): () => Promise<void> {
  const message = `Exec denied (node=${params.nodeId} id=${params.approvalId}, approval-request-failed): ${params.command}`;

  return async () => {
    if (params.signal?.aborted) {
      return;
    }
    try {
      await params.send(params.target, message);
    } catch {
      if (!params.signal?.aborted) {
        try {
          await params.send(params.target, message);
        } catch {
          // The delivery owner already records failures; detached work must settle.
        }
      }
    }
  };
}
