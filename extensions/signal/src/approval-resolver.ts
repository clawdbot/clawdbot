// Signal plugin module implements approval resolver behavior.
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";

export { isApprovalNotFoundError };

export async function resolveSignalApproval(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
}): Promise<void> {
  await resolveApprovalOverGateway({
    cfg: params.cfg,
    approvalId: params.approvalId,
    decision: params.decision,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: `Signal approval (${params.senderId?.trim() || "unknown"})`,
  });
}
