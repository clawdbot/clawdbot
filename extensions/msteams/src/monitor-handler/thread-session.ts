import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

export function resolveMSTeamsRouteSessionKey(params: {
  baseSessionKey: string;
  isChannel: boolean;
  conversationMessageId?: string;
  replyToId?: string;
}): string {
  const channelThreadId = params.isChannel
    ? (params.conversationMessageId ?? params.replyToId ?? undefined)
    : undefined;
  return resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: channelThreadId,
    parentSessionKey: channelThreadId ? params.baseSessionKey : undefined,
  }).sessionKey;
}
