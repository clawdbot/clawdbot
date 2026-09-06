// Builds normalized conversation binding inputs from channel and routing facts.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { resolveCommandConversationResolution } from "../../channels/conversation-resolution.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
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

export function resolveConversationBindingChannelFromMessage(
  ctx: BindingMsgContext,
  commandChannel?: string | null,
): string {
  const raw = ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider;
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(raw));
}

export function resolveConversationBindingAccountIdFromMessage(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  const channel = resolveConversationBindingChannelFromMessage(params.ctx, params.commandChannel);
  const plugin = getLoadedChannelPluginForRead(channel);
  const accountId = normalizeConversationText(params.ctx.AccountId);
  return (
    accountId ||
    normalizeConversationText(plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

export function resolveConversationBindingThreadIdFromMessage(
  ctx: Pick<BindingMsgContext, "MessageThreadId">,
): string | undefined {
  return stringifyRouteThreadId(ctx.MessageThreadId);
}

export function resolveConversationBindingContextFromMessage(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  commandTo?: string | null;
}): ReturnType<typeof resolveCommandConversationResolution> {
  return resolveCommandConversationResolution({
    cfg: params.cfg,
    channel: resolveConversationBindingChannelFromMessage(params.ctx),
    accountId: params.ctx.AccountId,
    chatType: params.ctx.ChatType,
    threadId: params.ctx.MessageThreadId,
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
): ReturnType<typeof resolveCommandConversationResolution> {
  return resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
    senderId: params.command.senderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    commandTo: params.command.to,
  });
}
