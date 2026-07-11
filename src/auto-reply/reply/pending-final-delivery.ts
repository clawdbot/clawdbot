import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
/** Sanitizes pending final delivery text before channel-visible output. */
import type { ReplyPayload } from "../types.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

/** Build the restart-recovery text represented by one or more final payloads. */
export function buildPendingFinalDeliveryText(payloads: ReplyPayload[]): string {
  const text = payloads
    .filter((payload) => payload.isReasoning !== true)
    .map((payload) => payload.text)
    .filter((textLocal): textLocal is string => Boolean(textLocal))
    .join("\n\n");
  return sanitizePendingFinalDeliveryText(text);
}

/** Sanitizes final pending-delivery text and removes silent control tokens. */
export function sanitizePendingFinalDeliveryText(text: string): string {
  let stripped = stripInternalMetadataForDisplay(text).trim();
  if (isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN)) {
    return "";
  }
  if (stripped && !isSilentReplyText(stripped, SILENT_REPLY_TOKEN)) {
    const hasLeadingSilentToken = startsWithSilentToken(stripped, SILENT_REPLY_TOKEN);
    if (hasLeadingSilentToken) {
      stripped = stripLeadingSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
    // Remove stray silent tokens only after confirming the payload is not entirely silent.
    if (
      hasLeadingSilentToken ||
      stripped.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())
    ) {
      stripped = stripSilentToken(stripped, SILENT_REPLY_TOKEN);
    }
  }
  if (!stripped.trim()) {
    return "";
  }
  return isSilentReplyPayloadText(stripped, SILENT_REPLY_TOKEN) ? "" : stripped.trim();
}
