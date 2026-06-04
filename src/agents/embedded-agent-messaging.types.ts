import type { ReplyPayload } from "../auto-reply/reply-payload.js";

// Messaging tool metadata captured during embedded agent runs.
export type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
};

// Reply payload subset preserved for message-tool idempotency and delivery.
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
