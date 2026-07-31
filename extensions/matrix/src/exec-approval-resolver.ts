// Matrix plugin module implements exec approval resolver behavior.
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";

export { isApprovalNotFoundError };

export async function resolveMatrixApproval(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
}): Promise<ApprovalResolveResult> {
  return await resolveApprovalOverGateway({
    cfg: params.cfg,
    approvalId: params.approvalId,
    approvalKind: params.approvalKind,
    decision: params.decision,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: `Matrix approval (${params.senderId?.trim() || "unknown"})`,
  });
}
