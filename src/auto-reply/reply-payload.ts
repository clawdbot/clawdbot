import type {
  InteractiveReply,
  MessagePresentation,
  ReplyPayloadDelivery,
} from "../interactive/payload.js";

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  /** Internal-only trust signal for gateway webchat local media embedding. */
  trustedLocalMedia?: boolean;
  /** Treat media as live-only content and avoid persisting the underlying media reference. */
  sensitiveMedia?: boolean;
  /** Channel-agnostic rich presentation. Core degrades or asks the channel renderer to map it. */
  presentation?: MessagePresentation;
  /** Channel-agnostic delivery preferences, e.g. pin the sent message when supported. */
  delivery?: ReplyPayloadDelivery;
  /**
   * @deprecated Use presentation.
   *
   * Internal legacy representation used by existing approval/reply helpers during migration.
   */
  interactive?: InteractiveReply;
  btw?: {
    question: string;
  };
  replyToId?: string;
  replyToTag?: boolean;
  /** True when [[reply_to_current]] was present but not yet mapped to a message id. */
  replyToCurrent?: boolean;
  /** Send audio as voice message (bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
  /**
   * Text synthesized into an audio-only TTS payload. Exposed to hooks for
   * archival/search use when no visible channel text is sent.
   */
  spokenText?: string;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};

export type ReplyPayloadMetadata = {
  assistantMessageIndex?: number;
  /**
   * Internal OpenClaw notices generated after a runtime/provider failure are
   * not assistant source replies. Dispatch may deliver them even when normal
   * assistant source replies are message-tool-only; sendPolicy deny still wins.
   */
  deliverDespiteSourceReplySuppression?: boolean;
  /**
   * A message-tool reply to the active internal UI source. The final payload is
   * still the live delivery vehicle; this mirror makes the reply durable for
   * chat.history and page reloads without turning the internal UI into an
   * outbound channel.
   */
  sourceReplyTranscriptMirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
    idempotencyKey?: string;
  };
  beforeAgentRunBlocked?: boolean;
};

const replyPayloadMetadata = new WeakMap<object, ReplyPayloadMetadata>();

export function setReplyPayloadMetadata<T extends object>(
  payload: T,
  metadata: ReplyPayloadMetadata,
): T {
  const previous = replyPayloadMetadata.get(payload);
  replyPayloadMetadata.set(payload, { ...previous, ...metadata });
  return payload;
}

export function getReplyPayloadMetadata(payload: object): ReplyPayloadMetadata | undefined {
  return replyPayloadMetadata.get(payload);
}

export function copyReplyPayloadMetadata<T extends object>(source: object, payload: T): T {
  const metadata = getReplyPayloadMetadata(source);
  return metadata ? setReplyPayloadMetadata(payload, metadata) : payload;
}

export function markReplyPayloadForSourceSuppressionDelivery<T extends object>(payload: T): T {
  return setReplyPayloadMetadata(payload, {
    deliverDespiteSourceReplySuppression: true,
  });
}
