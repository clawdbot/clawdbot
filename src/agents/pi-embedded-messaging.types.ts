import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  text?: string;
  mediaUrls?: string[];
};

export type MessagingToolSourceReplyPayload = Pick<
  ReplyPayload,
  | "audioAsVoice"
  | "channelData"
  | "interactive"
  | "mediaUrl"
  | "mediaUrls"
  | "presentation"
  | "text"
> & {
  idempotencyKey?: string;
};
