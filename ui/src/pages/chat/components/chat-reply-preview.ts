// Reply-preview resolution: memoized quoted-source previews served from
// already-loaded transcript rows first, then the reply-message access loader.
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import { resolveMessageReplyText } from "./chat-message-markdown.ts";
import type { MessageReplyTarget } from "./chat-message.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

export type LoadedReplySource = {
  message: unknown;
  messageId: string;
  senderLabel: string;
};

type ResolvedReplyPreview = (MessageReplyTarget & { sourceMessageId: string }) | undefined;

type ReplyPreviewProps = Pick<
  ChatThreadProps,
  "assistantName" | "replyMessageAccess" | "userAvatar" | "userId" | "userName"
>;

function projectResolvedReplyPreview(
  message: unknown,
  replyToId: string,
  props: ReplyPreviewProps,
): ResolvedReplyPreview {
  const normalized = normalizeMessage(message);
  const text = resolveMessageReplyText(message, normalized);
  if (!text) {
    return undefined;
  }
  const group = {
    role: normalized.role,
    senderLabel: normalized.senderLabel,
    ...(normalized.sender ? { sender: normalized.sender } : {}),
    messages: [{ key: replyToId, message }],
  };
  const sourceMessageId = persistedMessageEntryId(message) ?? replyToId;
  return {
    messageId: sourceMessageId,
    sourceMessageId,
    senderLabel: resolveMessageGroupSenderLabel(group, props),
    text,
  };
}

export function createReplyPreviewResolver(
  loadedReplySources: ReadonlyMap<string, LoadedReplySource>,
  props: ReplyPreviewProps,
): (replyToId: string) => ResolvedReplyPreview {
  const resolved = new Map<string, ResolvedReplyPreview>();
  return (replyToId) => {
    if (resolved.has(replyToId)) {
      return resolved.get(replyToId);
    }
    const loaded = loadedReplySources.get(replyToId);
    const loadedText = loaded ? resolveMessageReplyText(loaded.message) : undefined;
    if (loaded && loadedText) {
      const preview = {
        messageId: loaded.messageId,
        sourceMessageId: replyToId,
        senderLabel: loaded.senderLabel,
        text: loadedText,
      };
      resolved.set(replyToId, preview);
      return preview;
    }
    const message = props.replyMessageAccess?.read(replyToId);
    const preview = message ? projectResolvedReplyPreview(message, replyToId, props) : undefined;
    resolved.set(replyToId, preview);
    return preview;
  };
}
