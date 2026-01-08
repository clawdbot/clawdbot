import type { TypingController } from "./reply/typing.js";

export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
  onTypingController?: (typing: TypingController) => void;
  isHeartbeat?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onReasoningStream?: (payload: ReplyPayload) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  disableBlockStreaming?: boolean;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  isError?: boolean;
};
