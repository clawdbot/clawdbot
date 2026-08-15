// Implements ACP context commands for session metadata and prompt state.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../../acp/conversation-id.js";
import { normalizeConversationTargetRef } from "../../../infra/outbound/session-binding-normalization.js";
import type { HandleCommandsParams } from "../commands-types.js";
import {
  resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand,
  resolveConversationBindingThreadIdFromMessage,
} from "../conversation-binding-input.js";

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const resolved = resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel);
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(resolved));
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  return resolveConversationBindingAccountIdFromMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    commandChannel: params.command.channel,
  });
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  return resolveConversationBindingThreadIdFromMessage(params.ctx);
}

function resolveAcpCommandConversationRef(params: HandleCommandsParams): {
  conversationId: string;
  parentConversationId?: string;
} | null {
  const resolved = resolveConversationBindingContextFromAcpCommand(params);
  if (!resolved) {
    return null;
  }
  return normalizeConversationTargetRef({
    conversationId: resolved.conversationId,
    parentConversationId: resolved.parentConversationId,
  });
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  return resolveAcpCommandConversationRef(params)?.conversationId;
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const conversationRef = resolveAcpCommandConversationRef(params);
  if (!conversationRef) {
    return {
      channel: resolveAcpCommandChannel(params),
      accountId: resolveAcpCommandAccountId(params),
      threadId: resolveAcpCommandThreadId(params),
    };
  }
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: conversationRef.conversationId,
    ...(conversationRef.parentConversationId
      ? { parentConversationId: conversationRef.parentConversationId }
      : {}),
  };
}
