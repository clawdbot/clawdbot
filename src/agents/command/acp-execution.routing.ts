import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { AgentCommandOpts } from "./types.js";

function resolveSlackDeliveryFromSessionKey(sessionKey: string): {
  messageChannel?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
} {
  const ref = resolveSessionConversationRef(sessionKey, { bundledFallback: false });
  if (!ref || ref.channel !== "slack") {
    return {};
  }
  const currentMessagingTarget = ref.kind === "group" ? `group:${ref.id}` : `channel:${ref.id}`;
  return {
    messageChannel: "slack",
    currentMessagingTarget,
    ...(ref.threadId ? { currentThreadTs: ref.threadId } : {}),
  };
}

export function resolveAcpApprovalRouting(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  opts: AgentCommandOpts;
  sessionAgentId: string;
}) {
  const approvalSessionKey =
    normalizeOptionalString(params.sessionEntry?.parentSessionKey) ??
    normalizeOptionalString(params.sessionEntry?.spawnedBy) ??
    params.sessionKey;
  const approvalAgentId = resolveAgentIdFromSessionKey(approvalSessionKey, params.sessionAgentId);
  const approvalStorePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: approvalAgentId,
  });
  const routingEntry =
    approvalSessionKey === params.sessionKey
      ? params.sessionEntry
      : (params.sessionStore?.[approvalSessionKey] ??
        loadSessionEntryReadOnly({
          sessionKey: approvalSessionKey,
          agentId: approvalAgentId,
          storePath: approvalStorePath,
          clone: false,
        }));
  const routedDelivery = deliveryContextFromSession(routingEntry);
  const sessionKeyDelivery = resolveSlackDeliveryFromSessionKey(approvalSessionKey);
  // Prefer the parent Slack session's persisted delivery over child spawn opts.
  // Child opts can disagree with the parent session key and cause Slack to drop
  // origin-chat approval cards (DM-only fallback).
  const messageChannel =
    routedDelivery?.channel ??
    sessionKeyDelivery.messageChannel ??
    params.opts.channel ??
    params.opts.messageChannel ??
    params.opts.runContext?.messageChannel;
  const currentMessagingTarget =
    normalizeOptionalString(routedDelivery?.to) ??
    sessionKeyDelivery.currentMessagingTarget ??
    normalizeOptionalString(params.opts.to) ??
    normalizeOptionalString(params.opts.replyTo);
  const agentAccountId =
    normalizeOptionalString(routedDelivery?.accountId) ??
    normalizeOptionalString(params.opts.accountId) ??
    normalizeOptionalString(params.opts.replyAccountId);
  const currentThreadTs =
    normalizeOptionalString(routedDelivery?.threadId) ??
    sessionKeyDelivery.currentThreadTs ??
    (params.opts.threadId != null
      ? normalizeOptionalString(String(params.opts.threadId))
      : normalizeOptionalString(params.opts.runContext?.currentThreadTs));
  return {
    approvalSessionKey,
    approvalAgentId,
    messageChannel,
    currentMessagingTarget,
    agentAccountId,
    currentThreadTs,
  };
}
