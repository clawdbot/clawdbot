import {
  buildApprovalPresentation,
  buildApprovalPresentationFromActionDescriptors,
  type ExecApprovalActionDescriptor,
  type ExecApprovalReplyDecision,
} from "../infra/exec-approval-reply.js";
import {
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  resolvePluginApprovalRequestAllowedDecisions,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ReplyPayload } from "./reply-payload.js";

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

/** Build a pending approval reply payload using the portable presentation API. */
export function buildApprovalPendingReplyPayload(params: {
  approvalKind?: "exec" | "plugin";
  approvalId: string;
  approvalSlug: string;
  text: string;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  actions?: readonly ExecApprovalActionDescriptor[];
  sessionKey?: string | null;
  title?: string | null;
  description?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  pluginId?: string | null;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  const actions = params.actions?.length ? params.actions : undefined;
  const title = normalizeOptionalString(params.title);
  const description = normalizeOptionalString(params.description);
  const toolName = normalizeOptionalString(params.toolName);
  const pluginId = normalizeOptionalString(params.pluginId);
  return {
    text: params.text,
    presentation: actions
      ? buildApprovalPresentationFromActionDescriptors(actions)
      : buildApprovalPresentation({
          approvalId: params.approvalId,
          allowedDecisions,
        }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: params.approvalKind ?? "exec",
        agentId: normalizeOptionalString(params.agentId),
        allowedDecisions,
        ...(actions ? { actions } : {}),
        sessionKey: normalizeOptionalString(params.sessionKey),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(params.severity ? { severity: params.severity } : {}),
        ...(toolName ? { toolName } : {}),
        ...(pluginId ? { pluginId } : {}),
        state: "pending",
      },
      ...params.channelData,
    },
  };
}

/** Build a resolved approval reply payload with approval metadata but no controls. */
export function buildApprovalResolvedReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return {
    text: params.text,
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        state: "resolved",
      },
      ...params.channelData,
    },
  };
}

export function buildPluginApprovalPendingReplyPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
  text?: string;
  approvalSlug?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalPendingReplyPayload({
    approvalKind: "plugin",
    approvalId: params.request.id,
    approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
    text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
    allowedDecisions:
      params.allowedDecisions ??
      resolvePluginApprovalRequestAllowedDecisions(params.request.request),
    actions: params.request.request.actions ?? undefined,
    agentId: params.request.request.agentId,
    sessionKey: params.request.request.sessionKey,
    title: params.request.request.title,
    description: params.request.request.description,
    severity: params.request.request.severity,
    toolName: params.request.request.toolName,
    pluginId: params.request.request.pluginId,
    channelData: params.channelData,
  });
}

export function buildPluginApprovalResolvedReplyPayload(params: {
  resolved: PluginApprovalResolved;
  text?: string;
  approvalSlug?: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalResolvedReplyPayload({
    approvalId: params.resolved.id,
    approvalSlug: params.approvalSlug ?? params.resolved.id.slice(0, 8),
    text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
    channelData: params.channelData,
  });
}
