import type { ClawdbotConfig } from "../../config/config.js";
import type { MessageApprovalForwardingConfig } from "../../config/types.approvals.js";
import type { GatewayClient } from "../../gateway/client.js";
import type { MessageApprovalDecision } from "../../gateway/message-approval-manager.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

const log = createSubsystemLogger("message-approval-check");

export type MessageApprovalCheckParams = {
  action: string;
  channel: string;
  to: string;
  message?: string | null;
  mediaUrl?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

export function resolveMessageApprovalConfig(
  cfg: ClawdbotConfig,
): MessageApprovalForwardingConfig | undefined {
  return cfg.approvals?.message;
}

export function shouldRequireMessageApproval(params: {
  cfg: ClawdbotConfig;
  action: string;
  channel: string;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const config = resolveMessageApprovalConfig(params.cfg);
  if (!config?.enabled) return false;

  if (config.actions?.length) {
    if (!config.actions.includes(params.action)) return false;
  }

  if (config.channels?.length && !config.channels.includes("*")) {
    const channel = normalizeMessageChannel(params.channel);
    if (!channel || !config.channels.includes(channel)) return false;
  }

  if (config.agentFilter?.length) {
    const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
    if (!agentId) return false;
    if (!config.agentFilter.includes(agentId)) return false;
  }

  if (config.sessionFilter?.length) {
    const sessionKey = params.sessionKey;
    if (!sessionKey) return false;
    const matched = config.sessionFilter.some((pattern) => {
      try {
        return sessionKey.includes(pattern) || new RegExp(pattern).test(sessionKey);
      } catch {
        return sessionKey.includes(pattern);
      }
    });
    if (!matched) return false;
  }

  return true;
}

export type RequestMessageApprovalParams = {
  cfg: ClawdbotConfig;
  gateway: GatewayClient;
  action: string;
  channel: string;
  to: string;
  message?: string | null;
  mediaUrl?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

export type RequestMessageApprovalResult = {
  decision: MessageApprovalDecision | null;
  id: string;
  /** Error message if the request failed (distinct from timeout which has null decision but no error). */
  error?: string;
};

export async function requestMessageApproval(
  params: RequestMessageApprovalParams,
): Promise<RequestMessageApprovalResult> {
  const config = resolveMessageApprovalConfig(params.cfg);
  const timeoutMs = (config?.timeout ?? 120) * 1000;

  try {
    const result = await params.gateway.request<{
      id: string;
      decision: MessageApprovalDecision | null;
    }>("message.approval.request", {
      action: params.action,
      channel: params.channel,
      to: params.to,
      message: params.message ?? null,
      mediaUrl: params.mediaUrl ?? null,
      agentId: params.agentId ?? null,
      sessionKey: params.sessionKey ?? null,
      timeoutMs,
    });

    return { decision: result.decision, id: result.id };
  } catch (err) {
    const errorMsg = String(err);
    log.error(`message approval request error: ${errorMsg}`);
    return { decision: null, id: "", error: errorMsg };
  }
}
