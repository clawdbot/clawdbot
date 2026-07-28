import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { loadSessionStoreEntry, resolveStorePath } from "./dispatch-from-config.runtime.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { isSlackDirectRoutedThreadTurn } from "./routed-delivery-thread.js";

function routeThreadIdsDiffer(
  left: string | number | undefined,
  right: string | number | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return String(left) !== String(right);
}

export function shouldLetSlackRoutedThreadBypassBusyReplyOperation(params: {
  activeOperation?: ReplyOperation;
  ctx: FinalizedMsgContext;
  routeThreadId?: string | number;
}): boolean {
  return (
    isSlackDirectRoutedThreadTurn(params.ctx) &&
    routeThreadIdsDiffer(params.activeOperation?.routeThreadId, params.routeThreadId)
  );
}

export function resolveRoutedPolicyConversationType(
  ctx: FinalizedMsgContext,
): "direct" | "group" | undefined {
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  if (commandTargetSessionKey && commandTargetSessionKey !== ctx.SessionKey) {
    return undefined;
  }
  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "group";
  }
  return undefined;
}

export function resolveSessionStoreLookup(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  storePath?: string;
  entry?: SessionEntry;
  store?: Record<string, SessionEntry>;
} {
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const entry = loadSessionStoreEntry({
      agentId,
      storePath,
      sessionKey,
      readConsistency: "latest",
      clone: false,
    });
    return {
      sessionKey,
      storePath,
      entry,
      store: entry ? { [sessionKey]: entry } : undefined,
    };
  } catch {
    return {
      sessionKey,
      storePath,
    };
  }
}

export function resolveBoundAcpDispatchSessionKey(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): string | undefined {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  if (!bindingContext) {
    return undefined;
  }

  const binding = getSessionBindingService().resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  const targetSessionKey = normalizeOptionalString(binding?.targetSessionKey);
  if (!binding || !targetSessionKey || !isAcpSessionKey(targetSessionKey)) {
    return undefined;
  }
  if (isPluginOwnedSessionBindingRecord(binding)) {
    return undefined;
  }
  getSessionBindingService().touch(binding.bindingId);
  return targetSessionKey;
}
