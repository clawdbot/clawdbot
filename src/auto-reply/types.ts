export type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
  isHeartbeat?: boolean;
};

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};
