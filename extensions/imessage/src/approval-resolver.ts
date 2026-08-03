// Imessage plugin module implements approval resolver behavior.
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";

export { isApprovalNotFoundError };

export type IMessageApprovalGatewayRuntime = {
  request: (
    method: "approval.resolve",
    params: {
      id: string;
      kind: "exec" | "plugin" | "system-agent";
      decision: ExecApprovalReplyDecision;
    },
    options?: { clientDisplayName?: string },
  ) => Promise<ApprovalResolveResult>;
};

export async function resolveIMessageApproval(params: {
  cfg: OpenClawConfig;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
  gatewayRuntime?: IMessageApprovalGatewayRuntime;
}): Promise<ApprovalResolveResult> {
  return await resolveApprovalOverGateway({
    cfg: params.cfg,
    approvalId: params.approvalId,
    approvalKind: params.approvalKind,
    decision: params.decision,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    ...(params.gatewayRuntime ? { gatewayRuntime: params.gatewayRuntime } : {}),
    clientDisplayName: `iMessage approval (${params.senderId?.trim() || "unknown"})`,
  });
}
