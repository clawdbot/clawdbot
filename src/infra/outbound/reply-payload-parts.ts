import { normalizeStringEntries } from "../../../packages/normalization-core/src/string-normalization.js";

/** Derived sendability facts for text/media outbound payload delivery. */
export type SendableOutboundReplyParts = {
  /** Raw text selected for delivery before trimming. */
  text: string;
  /** Text after trimming whitespace for sendability checks. */
  trimmedText: string;
  /** Normalized non-empty media URLs. */
  mediaUrls: string[];
  /** Number of normalized media URLs. */
  mediaCount: number;
  /** Whether trimmed text is sendable. */
  hasText: boolean;
  /** Whether at least one media URL is sendable. */
  hasMedia: boolean;
  /** Whether the payload has any sendable text or media. */
  hasContent: boolean;
};

/** Prefer multi-attachment payloads, then fall back to the legacy single-media field. */
export function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  return [];
}

/** Count outbound media items after legacy single-media fallback normalization. */
export function countOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): number {
  return resolveOutboundMediaUrls(payload).length;
}

/** Check whether an outbound payload includes any media after normalization. */
export function hasOutboundMedia(payload: { mediaUrls?: string[]; mediaUrl?: string }): boolean {
  return countOutboundMedia(payload) > 0;
}

/** Check whether an outbound payload includes text, optionally trimming whitespace first. */
export function hasOutboundText(payload: { text?: string }, options?: { trim?: boolean }): boolean {
  const text = options?.trim ? payload.text?.trim() : payload.text;
  return Boolean(text);
}

/** Normalize reply payload text/media into a trimmed, sendable shape for delivery paths. */
export function resolveSendableOutboundReplyParts(
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  options?: { text?: string },
): SendableOutboundReplyParts {
  const text = options?.text ?? payload.text ?? "";
  const trimmedText = text.trim();
  const mediaUrls = normalizeStringEntries(resolveOutboundMediaUrls(payload));
  const mediaCount = mediaUrls.length;
  const hasText = Boolean(trimmedText);
  const hasMedia = mediaCount > 0;
  return {
    text,
    trimmedText,
    mediaUrls,
    mediaCount,
    hasText,
    hasMedia,
    hasContent: hasText || hasMedia,
  };
}
