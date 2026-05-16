import { stripInternalRuntimeContext } from "../../agents/internal-runtime-context.js";
import { stripEnvelope, stripMessageIdHints } from "../../shared/chat-envelope.js";
import { stripInboundMetadata } from "./strip-inbound-meta.js";

export function stripInternalMetadataForDisplay(text: string): string {
  return stripInboundMetadata(stripInternalRuntimeContext(text));
}

export function stripUserEnvelopeForDisplay(text: string): string {
  return stripMessageIdHints(stripEnvelope(stripInternalMetadataForDisplay(text)));
}
