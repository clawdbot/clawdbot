import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../tokens.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

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
