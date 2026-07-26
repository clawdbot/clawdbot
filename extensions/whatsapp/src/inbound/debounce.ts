import { normalizeWebInboundMessage } from "./message-aliases.js";
import type { WebInboundMessageInput, WhatsAppInboundMedia } from "./types.js";

export const MAX_WHATSAPP_PLUGIN_DEBOUNCE_MS = 5 * 60_000;

export function resolveWhatsAppPrimaryInboundMedia(
  mediaItems: readonly WhatsAppInboundMedia[],
): WhatsAppInboundMedia | undefined {
  // The singular compatibility alias must point at a transferable attachment
  // when a batch also contains metadata-only media entries.
  return mediaItems.find((entry) => entry.path || entry.url) ?? mediaItems[0];
}

export function hasWhatsAppInboundMedia(msg: WebInboundMessageInput): boolean {
  const normalized = normalizeWebInboundMessage(msg);
  const mediaItems =
    normalized.payload.mediaItems ?? (normalized.payload.media ? [normalized.payload.media] : []);
  return mediaItems.some((entry) => Boolean(entry.path || entry.url || entry.type || entry.kind));
}

export function resolveWhatsAppInboundMaxBufferAgeMs(
  msg: WebInboundMessageInput,
): number | undefined {
  return hasWhatsAppInboundMedia(msg) ? MAX_WHATSAPP_PLUGIN_DEBOUNCE_MS : undefined;
}
