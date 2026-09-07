import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding-metadata.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import {
  isNativeCommandTurn,
  resolveCommandTurnTargetSessionKey,
} from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import {
  loadSessionStoreEntry,
  resolveSessionStorePathCore,
} from "./dispatch-from-config.runtime.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { isSlackDirectRoutedThreadTurn } from "./routed-delivery-thread.js";
import { canReplaceRestartTombstoneFromParent } from "./session-parent-fork-prepare.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";

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
  agentId?: string;
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
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const target = { agentId, sessionKey, storePath };
  try {
    const entry = loadSessionStoreEntry({
      ...target,
      readConsistency: "latest",
      clone: false,
    });
    return {
      ...target,
      entry,
      store: entry ? { [sessionKey]: entry } : undefined,
    };
  } catch {
    return target;
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
  getSessionBindingService().touch(binding.bindingId, undefined, binding.conversation);
  return targetSessionKey;
}

export function resolveDispatchResetAdmission(params: {
  agentId: string;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  sessionKey?: string;
  storePath?: string;
}): {
  allowRestartTombstoneParentFork: boolean;
  allowRestartTombstoneReset: boolean;
  resetTriggered: boolean;
} {
  const { ctx, entry } = params;
  const parentSessionKey = normalizeOptionalString(ctx.ParentSessionKey);
  const commandTarget = resolveCommandTurnTargetSessionKey(ctx);
  const nativeCommandTarget = isNativeCommandTurn(ctx.CommandTurn) ? commandTarget : undefined;
  const actorType = classifySessionStateActor({
    inputProvenance: ctx.InputProvenance,
  }).actorType;
  const mayReplaceRestartTombstoneFromParent = canReplaceRestartTombstoneFromParent({
    actorType,
    entry,
    // Parent existence is the only remaining fact. Avoid its synchronous store
    // lookup until the already-loaded child and inbound authority require it.
    hasParentForkSource: true,
    hasPluginOwnedBinding: params.hasPluginOwnedBinding,
    inboundAccessAuthorized: ctx.InboundAccessAuthorized,
    inboundEventKind: ctx.InboundEventKind,
    nativeCommandTarget: commandTarget,
    sessionKey: params.sessionKey,
  });
  let hasParentForkSource = false;
  if (
    mayReplaceRestartTombstoneFromParent &&
    parentSessionKey &&
    parentSessionKey !== params.sessionKey &&
    params.storePath
  ) {
    try {
      hasParentForkSource = Boolean(
        loadSessionStoreEntry({
          agentId: params.agentId,
          storePath: params.storePath,
          sessionKey: parentSessionKey,
          readConsistency: "latest",
          clone: false,
        })?.sessionId,
      );
    } catch {
      hasParentForkSource = false;
    }
  }
  const allowRestartTombstoneParentFork =
    mayReplaceRestartTombstoneFromParent && hasParentForkSource;
  if (
    params.hasPluginOwnedBinding ||
    entry?.pluginOwnerId !== undefined ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    (nativeCommandTarget !== undefined && nativeCommandTarget !== params.sessionKey) ||
    actorType !== "human"
  ) {
    return {
      allowRestartTombstoneParentFork,
      allowRestartTombstoneReset: false,
      resetTriggered: false,
    };
  }
  const normalizedChatType = normalizeChatType(ctx.ChatType);
  const isGroup =
    normalizedChatType != null && normalizedChatType !== "direct"
      ? true
      : Boolean(resolveGroupSessionKey(ctx));
  const { resetCommand } = resolveAuthorizedSessionResetCommand({
    agentId: params.agentId,
    cfg: params.cfg,
    commandAuthorized: ctx.CommandAuthorized,
    ctx,
    isGroup,
  });
  const resetTriggered = resetCommand.matchedResetTriggerLower !== undefined;
  return {
    resetTriggered,
    allowRestartTombstoneParentFork,
    // Admission rereads lifecycle state after waits; carry authority, not the earlier tombstone state.
    allowRestartTombstoneReset: resetTriggered,
  };
}
