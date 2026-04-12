import { normalizeConversationText } from "../../acp/conversation-id.js";
import { resolveConversationBindingContext } from "../../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

type BindingMsgContext = Pick<
  MsgContext,
  | "OriginatingChannel"
  | "Surface"
  | "Provider"
  | "AccountId"
  | "ChatType"
  | "MessageThreadId"
  | "ThreadParentId"
  | "SenderId"
  | "SessionKey"
  | "ParentSessionKey"
  | "OriginatingTo"
  | "To"
  | "From"
  | "NativeChannelId"
>;

function resolveBindingChannel(ctx: BindingMsgContext, commandChannel?: string | null): string {
  const raw = ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider;
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(raw));
}

function resolveBindingAccountId(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  const channel = resolveBindingChannel(params.ctx, params.commandChannel);
  const plugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  const accountId = normalizeConversationText(params.ctx.AccountId);
  return (
    accountId ||
    normalizeConversationText(plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

function resolveBindingThreadId(threadId: string | number | null | undefined): string | undefined {
  const normalized = threadId != null ? normalizeConversationText(String(threadId)) : undefined;
  return normalized || undefined;
}

export function resolveConversationBindingContextFromMessage(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  commandTo?: string | null;
}): ReturnType<typeof resolveConversationBindingContext> {
  const channel = resolveBindingChannel(params.ctx);
  return resolveConversationBindingContext({
    cfg: params.cfg,
    channel,
    accountId: resolveBindingAccountId({
      ctx: params.ctx,
      cfg: params.cfg,
      commandChannel: channel,
    }),
    chatType: params.ctx.ChatType,
    threadId: resolveBindingThreadId(params.ctx.MessageThreadId),
    threadParentId: params.ctx.ThreadParentId,
    senderId: params.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    parentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
    from: params.ctx.From,
    originatingTo: params.ctx.OriginatingTo,
    commandTo: params.commandTo,
    fallbackTo: params.ctx.To,
    nativeChannelId: params.ctx.NativeChannelId,
  });
}

export function resolveConversationBindingContextFromAcpCommand(
  params: HandleCommandsParams,
): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
    senderId: params.command.senderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    commandTo: params.command.to,
  });
}

export function resolveConversationBindingChannelFromMessage(
  ctx: BindingMsgContext,
  commandChannel?: string | null,
): string {
  return resolveBindingChannel(ctx, commandChannel);
}

export function resolveConversationBindingAccountIdFromMessage(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  return resolveBindingAccountId(params);
}

export function resolveConversationBindingThreadIdFromMessage(
  ctx: Pick<BindingMsgContext, "MessageThreadId">,
): string | undefined {
  return resolveBindingThreadId(ctx.MessageThreadId);
}
