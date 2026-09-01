import type { ReplyToResolution } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";

// Keep the native reference and its physical-send scope together so text, media,
// component, and voice paths cannot desynchronize parallel reply options.
export type DiscordReplyReference = Readonly<{
  messageId: string;
  scope: "all" | "first";
}>;

export function resolveDiscordReplyReference(params: {
  replyToId?: string | null;
  replyToIdSource?: ReplyToResolution["source"];
  replyToMode?: ReplyToMode;
}): DiscordReplyReference | undefined {
  if (!params.replyToId) {
    return undefined;
  }
  const singleUse =
    params.replyToIdSource !== "explicit" &&
    params.replyToMode !== undefined &&
    isSingleUseReplyToMode(params.replyToMode);
  return { messageId: params.replyToId, scope: singleUse ? "first" : "all" };
}

export function createReusableDiscordReplyReference(
  messageId?: string | null,
): DiscordReplyReference | undefined {
  return messageId ? { messageId, scope: "all" } : undefined;
}

export function resolveDiscordReplyMessageId(
  reply: DiscordReplyReference | undefined,
  isFirst: boolean,
): string | undefined {
  return reply && (isFirst || reply.scope === "all") ? reply.messageId : undefined;
}
