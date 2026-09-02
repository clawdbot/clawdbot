// Implements ACP context commands for session metadata and prompt state.
import { normalizeConversationTargetRef } from "../../../infra/outbound/session-binding-normalization.js";
import type { HandleCommandsParams } from "../commands-types.js";
import {
  resolveConversationBindingAccountIdFromMessage,
  resolveConversationBindingChannelFromMessage,
  resolveConversationBindingContextFromAcpCommand,
  resolveConversationBindingThreadIdFromMessage,
} from "../conversation-binding-input.js";

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  return resolveConversationBindingChannelFromMessage(params.ctx, params.command.channel);
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  return resolveConversationBindingThreadIdFromMessage(params.ctx);
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const resolved = resolveConversationBindingContextFromAcpCommand(params);
  if (resolved) {
    // Binding lookup drops self-parent defaults that inbound routing may retain.
    return normalizeConversationTargetRef(resolved);
  }
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveConversationBindingAccountIdFromMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      commandChannel: params.command.channel,
    }),
    threadId: resolveAcpCommandThreadId(params),
  };
}
