/**
 * Shared messaging-tool metadata types captured from embedded-agent runs.
 */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

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
  hasRichContent?: true;
  /** Current-source progress (`false`) or completed reply (`true`). */
  sourceReplyFinal?: boolean;
};

export type MessagingToolSourceReplyPayload = Pick<
  ReplyPayload,
  | "audioAsVoice"
  | "attachments"
  | "channelData"
  | "interactive"
  | "location"
  | "mediaUrl"
  | "mediaUrls"
  | "presentation"
  | "text"
  | "trustedLocalMedia"
> & {
  idempotencyKey?: string;
  transcriptOwner?: true;
  /** Prepared by the message tool but not sent; the channel host owns delivery. */
  hostFinalDeferred?: true;
  /** Current-source progress (`false`) or completed reply (`true`). */
  sourceReplyFinal?: boolean;
};
