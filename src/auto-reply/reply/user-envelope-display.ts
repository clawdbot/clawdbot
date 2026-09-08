import { stripEnvelope } from "../../shared/chat-envelope.js";
import { stripMessageIdHints } from "../../shared/text/message-id-hints.js";
import { stripInternalMetadataForDisplay } from "./display-text-sanitize.js";

/** Removes user-envelope and message-id hints from display text. */
export function stripUserEnvelopeForDisplay(text: string): string {
  return stripMessageIdHints(stripEnvelope(stripInternalMetadataForDisplay(text)));
}
