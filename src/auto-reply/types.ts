export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
  isHeartbeat?: boolean;
  onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  onBlockReply?: (payload: ReplyPayload) => Promise<void> | void;
  onToolResult?: (payload: ReplyPayload) => Promise<void> | void;
  /** If provided, only load these skills for this session (empty = no skills). */
  skillFilter?: string[];
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
};
