import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export type GoogleChatDurableReplyOptions = {
  to: string;
  replyToId?: string;
  threadId?: string;
};

export function resolveGoogleChatDurableReplyOptions(params: {
  payload: ReplyPayload;
  infoKind: string;
  spaceId: string;
  typingMessageName?: string;
}): GoogleChatDurableReplyOptions | false {
  if (params.infoKind !== "final" || params.typingMessageName) {
    return false;
  }
  const threadId = params.payload.replyToId?.trim() || undefined;
  return {
    to: params.spaceId,
    ...(threadId ? { replyToId: threadId, threadId } : {}),
  };
}
