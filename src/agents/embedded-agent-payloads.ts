/**
 * Channel-facing reply payload emitted by embedded agents. Keep this type
 * small: channel adapters decide how to render text, media, and reply targets.
 */
export type BlockReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  trustedLocalMedia?: boolean;
  sensitiveMedia?: boolean;
  isReasoning?: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};
