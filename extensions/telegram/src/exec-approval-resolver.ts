// Telegram plugin module resolves typed operator approvals through the Gateway.
import {
  resolveApprovalOverGateway,
  type ApprovalResolveResult,
} from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type ResolveTelegramApprovalParams = {
  cfg: OpenClawConfig;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ExecApprovalReplyDecision;
  senderId?: string | null;
  gatewayUrl?: string;
};

type ResolveTelegramLegacyApprovalParams = Omit<ResolveTelegramApprovalParams, "approvalKind"> & {
  approvalKind: "exec" | "plugin";
};

export async function resolveTelegramApproval(
  params: ResolveTelegramApprovalParams,
): Promise<ApprovalResolveResult> {
  return await resolveApprovalOverGateway({
    cfg: params.cfg,
    approvalId: params.approvalId,
    approvalKind: params.approvalKind,
    decision: params.decision,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: `Telegram approval (${params.senderId?.trim() || "unknown"})`,
  });
}

/** Compatibility resolver for command/value buttons that predate typed approval actions. */
export async function resolveTelegramLegacyApproval(
  params: ResolveTelegramLegacyApprovalParams,
): Promise<void> {
  await resolveApprovalOverGateway({
    cfg: params.cfg,
    approvalId: params.approvalId,
    decision: params.decision,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    resolveMethod: params.approvalKind,
    clientDisplayName: `Telegram approval (${params.senderId?.trim() || "unknown"})`,
  });
}
