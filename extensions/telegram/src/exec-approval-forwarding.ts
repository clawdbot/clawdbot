import {
  buildExecApprovalPendingReplyPayload,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalCommandDisplay,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeMessageChannel } from "openclaw/plugin-sdk/routing";
import { isTelegramExecApprovalClientEnabled } from "./exec-approvals.js";

export function shouldSuppressTelegramExecApprovalForwardingFallback(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  request: ExecApprovalRequest;
}): boolean {
  const channel = normalizeMessageChannel(params.target.channel) ?? params.target.channel;
  if (channel !== "telegram") {
    return false;
  }
  const requestChannel = normalizeMessageChannel(params.request.request.turnSourceChannel ?? "");
  if (requestChannel !== "telegram") {
    return false;
  }
  const accountId =
    params.target.accountId?.trim() || params.request.request.turnSourceAccountId?.trim();
  return isTelegramExecApprovalClientEnabled({ cfg: params.cfg, accountId });
}

export function buildTelegramExecApprovalPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}) {
  return buildExecApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    approvalCommandId: params.request.id,
    warningText: params.request.request.warningText ?? undefined,
    command: resolveExecApprovalCommandDisplay(params.request.request).commandText,
    cwd: params.request.request.cwd ?? undefined,
    host: params.request.request.host === "node" ? "node" : "gateway",
    nodeId: params.request.request.nodeId ?? undefined,
    allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
    expiresAtMs: params.request.expiresAtMs,
    nowMs: params.nowMs,
  });
}
