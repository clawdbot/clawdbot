import type { OutboundLocation } from "../channels/location.js";
/** Reply payload contracts and metadata helpers shared by dispatch and channel renderers. */
import type { ReplyToMode } from "../config/types.base.js";
import type {
  InteractiveReply,
  MessagePresentation,
  ReplyPayloadDelivery,
} from "../interactive/payload.js";

/** Channel-agnostic assistant reply payload. */
export type ReplyPayload = {
  text?: string;
  /** Visible body a channel adapter may use when native structured content requires text. */
  fallbackText?: {
    text: string;
    /** Batch payload replaced when the adapter adopts this fallback body. */
    replacesPayloadIndex?: number;
  };
  mediaUrl?: string;
  mediaUrls?: string[];
  /** Internal-only trust signal for gateway webchat local media embedding. */
  trustedLocalMedia?: boolean;
  /** Treat media as live-only content and avoid persisting the underlying media reference. */
  sensitiveMedia?: boolean;
  /** Channel-agnostic rich presentation. Core degrades or asks the channel renderer to map it. */
  presentation?: MessagePresentation;
  /** Runtime-authored text is the exact fallback, not additional native presentation content. */
  presentationTextMode?: "fallback";
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
  /** Send video media as a round video note when the channel supports it. */
  videoAsNote?: boolean;
  /** Channel-neutral geographic location or named place. */
  location?: OutboundLocation;
  /**
   * Text synthesized into an audio-only TTS payload. Exposed to hooks for
   * archival/search use when no visible channel text is sent.
   */
  spokenText?: string;
  /**
   * Marks a TTS media payload as supplemental audio for assistant text that is
   * already visible through streaming or transcript projection.
   */
  ttsSupplement?: ReplyPayloadTtsSupplement;
  isError?: boolean;
  /** Marks this payload as a reasoning/thinking block. Channels that do not
   *  have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it. */
  isReasoning?: boolean;
  /** Marks pre-tool commentary (💬) — a display lane, suppressed unless the channel opts in. */
  isCommentary?: boolean;
  /** Reasoning stream text is a complete replacement snapshot, not a delta. */
  isReasoningSnapshot?: boolean;
  /** Marks this payload as a compaction status notice (start/end).
   *  Should be excluded from TTS transcript accumulation so compaction
   *  status lines are not synthesised into the spoken assistant reply. */
  isCompactionNotice?: boolean;
  /** Marks this payload as a model-fallback transition/recovery notice. */
  isFallbackNotice?: boolean;
  /** Marks this payload as transient status, not assistant answer content. */
  isStatusNotice?: boolean;
  /** Channel-specific payload data (per-channel envelope). */
  channelData?: Record<string, unknown>;
};

// Private device-pair -> Gateway live-display envelope key. Do not re-export
// through Plugin SDK; this is not a third-party plugin contract.
const PAIRING_QR_REPLY_CHANNEL_DATA_KEY = "openclawPairingQr";

type PairingQrReplyChannelData = {
  setupCode: string;
  expiresAtMs: number;
};

function normalizePairingQrSetupCode(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizePairingQrExpiresAtMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function readPairingQrReplyChannelData(
  payload: Pick<ReplyPayload, "channelData">,
): PairingQrReplyChannelData | undefined {
  const raw = payload.channelData?.[PAIRING_QR_REPLY_CHANNEL_DATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const setupCode = normalizePairingQrSetupCode(record.setupCode);
  const expiresAtMs = normalizePairingQrExpiresAtMs(record.expiresAtMs);
  return setupCode && expiresAtMs ? { setupCode, expiresAtMs } : undefined;
}

/** Metadata for fast-auto progress notices. */
export const FAST_MODE_AUTO_PROGRESS_KIND = "fast-mode-auto";

export function isFastModeAutoProgressPayload(payload: Pick<ReplyPayload, "channelData">): boolean {
  return payload.channelData?.openclawProgressKind === FAST_MODE_AUTO_PROGRESS_KIND;
}

/** Metadata for audio-only media that supplements already-visible assistant text. */
export type ReplyPayloadTtsSupplement = {
  spokenText: string;
  visibleTextAlreadyDelivered?: boolean;
};

/** Reply policy facts that provider adapters use to resolve the final transport route. */
export type ReplyDeliveryContext = {
  chatType?: "direct" | "group" | "channel" | null;
  replyToMode: ReplyToMode;
};

const REPLY_MEDIA_FAILURE_WARNING = "⚠️ Media failed.";

/** Appends the standard media failure warning without duplicating it. */
export function appendReplyMediaFailureWarning(text: string | undefined): string {
  if (!text?.trim()) {
    return REPLY_MEDIA_FAILURE_WARNING;
  }
  if (text.includes(REPLY_MEDIA_FAILURE_WARNING)) {
    return text;
  }
  return `${text}\n${REPLY_MEDIA_FAILURE_WARNING}`;
}

function normalizeTtsSupplementSpokenText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hasReplyPayloadMedia(payload: Pick<ReplyPayload, "mediaUrl" | "mediaUrls">): boolean {
  return Boolean(payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url.trim()));
}

/** Returns normalized TTS supplement metadata only when the payload has media to carry it. */
export function getReplyPayloadTtsSupplement(
  payload: Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "ttsSupplement">,
): ReplyPayloadTtsSupplement | undefined {
  const spokenText = normalizeTtsSupplementSpokenText(payload.ttsSupplement?.spokenText);
  if (!spokenText || !hasReplyPayloadMedia(payload)) {
    return undefined;
  }
  return {
    spokenText,
    ...(payload.ttsSupplement?.visibleTextAlreadyDelivered === true
      ? { visibleTextAlreadyDelivered: true }
      : {}),
  };
}

/** Returns true when the payload is a valid TTS supplement media payload. */
export function isReplyPayloadTtsSupplement(
  payload: Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "ttsSupplement">,
): boolean {
  return Boolean(getReplyPayloadTtsSupplement(payload));
}

/** Marks a reply payload as supplemental TTS media while preserving the original shape. */
export function markReplyPayloadAsTtsSupplement<T extends ReplyPayload>(
  payload: T,
  spokenText: string = payload.spokenText ?? payload.text ?? "",
  options?: { visibleTextAlreadyDelivered?: boolean },
): T {
  const normalizedSpokenText = normalizeTtsSupplementSpokenText(spokenText);
  if (!normalizedSpokenText) {
    return payload;
  }
  return {
    ...payload,
    spokenText: normalizedSpokenText,
    ttsSupplement: {
      spokenText: normalizedSpokenText,
      ...(options?.visibleTextAlreadyDelivered === true
        ? { visibleTextAlreadyDelivered: true }
        : {}),
    },
  };
}

/** Removes visible-only fields from a payload that should be delivered as TTS supplement media. */
export function buildTtsSupplementMediaPayload(payload: ReplyPayload): ReplyPayload {
  const supplement = getReplyPayloadTtsSupplement(payload);
  if (!supplement) {
    return payload;
  }
  const {
    text: _text,
    presentation: _presentation,
    interactive: _interactive,
    btw: _btw,
    ...mediaPayload
  } = payload;
  return {
    ...mediaPayload,
    spokenText: supplement.spokenText,
    ttsSupplement: supplement,
  };
}

/** WeakMap-backed metadata attached to payload objects without changing wire shape. */
export type ReplyPayloadMetadata = {
  assistantMessageIndex?: number;
  /** The runtime owns the transcript decision for this assistant payload. */
  assistantTranscriptOwned?: boolean;
  /** Exact key for replacing a runtime-owned assistant row after media materialization. */
  assistantTranscriptIdempotencyKey?: string;
  /** Foreground freshness prevented a visible final after transcript persistence. */
  foregroundDeliverySuppression?: {
    reason: "stale-foreground";
  };
  /** Opaque owner for one final-delivery transcript capture on a shared dispatcher. */
  finalDeliveryCapture?: object;
  /** Durable pending-final intent represented by this runtime payload. */
  pendingFinalDeliveryIntentId?: string;
  /** Restart-safe text this payload contributes to its pending-final intent. */
  pendingFinalDeliveryRetryText?: string;
  /** replyToId existed before reply threading could inject an implicit target. */
  replyToIdExplicit?: boolean;
  /** Canonical reply policy used by both message-tool dedupe and final delivery routing. */
  replyDelivery?: ReplyDeliveryContext;
  /** Route identity that produced replyDelivery, used to reject stale cross-route policy. */
  replyDeliverySource?: {
    channel: string;
    accountId?: string;
  };
  /**
   * Internal OpenClaw notices and host-owned artifacts are not assistant source
   * replies. Dispatch may deliver them even when normal assistant source replies
   * are message-tool-only; sendPolicy deny still wins.
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
    expectedSessionId?: string;
    /** Delivery stays live, but neither side may be appended to a transcript. */
    transcriptWriteBlocked?: boolean;
    text?: string;
    mediaUrls?: string[];
    idempotencyKey?: string;
  };
  beforeAgentRunBlocked?: boolean;
  /** Warning synthesized from an observed tool error after the run produced assistant output. */
  nonTerminalToolErrorWarning?: boolean;
  /** Unresolved mutating tool failure that makes a heartbeat run terminally failed. */
  heartbeatTerminalToolFailure?: {
    toolName: string;
  };
};

const replyPayloadMetadata = new WeakMap<object, ReplyPayloadMetadata>();

/** Adds internal metadata to a reply payload object. */
export function setReplyPayloadMetadata<T extends object>(
  payload: T,
  metadata: ReplyPayloadMetadata,
): T {
  const previous = replyPayloadMetadata.get(payload);
  replyPayloadMetadata.set(payload, { ...previous, ...metadata });
  return payload;
}

/** Reads internal metadata attached to a reply payload object. */
export function getReplyPayloadMetadata(payload: object): ReplyPayloadMetadata | undefined {
  return replyPayloadMetadata.get(payload);
}

/** Returns true when a payload is the synthesized warning for a non-terminal tool error. */
export function isReplyPayloadNonTerminalToolErrorWarning(payload: object): boolean {
  return getReplyPayloadMetadata(payload)?.nonTerminalToolErrorWarning === true;
}

/** Copies internal payload metadata when cloning or transforming payload objects. */
export function copyReplyPayloadMetadata<T extends object>(source: object, payload: T): T {
  const metadata = getReplyPayloadMetadata(source);
  return metadata ? setReplyPayloadMetadata(payload, metadata) : payload;
}

/** Marks a host-owned payload as deliverable even when normal source replies are suppressed. */
export function markReplyPayloadForSourceSuppressionDelivery<T extends object>(payload: T): T {
  return setReplyPayloadMetadata(payload, {
    deliverDespiteSourceReplySuppression: true,
  });
}

export function markCommandReplyForDelivery(
  reply: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | ReplyPayload[] | undefined {
  if (!reply) {
    return reply;
  }
  if (Array.isArray(reply)) {
    return reply.map((payload) => markReplyPayloadForSourceSuppressionDelivery(payload));
  }
  return markReplyPayloadForSourceSuppressionDelivery(reply);
}

/** Returns true for internal status/notice payloads, not assistant answer content. */
export function isReplyPayloadStatusNotice(
  payload: Pick<ReplyPayload, "isCompactionNotice" | "isFallbackNotice" | "isStatusNotice">,
): boolean {
  return Boolean(payload.isCompactionNotice || payload.isFallbackNotice || payload.isStatusNotice);
}
