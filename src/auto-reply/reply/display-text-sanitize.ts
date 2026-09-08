// Removes internal runtime context from text shown back to users.
// Keep this leaf free of Markdown parsing: terminal and transformed SDK paths import it.
import { stripInternalRuntimeContext } from "../../agents/internal-runtime-context.js";
import { stripInboundMetadata } from "./strip-inbound-meta.js";

/** Removes internal runtime metadata before showing text to users. */
export function stripInternalMetadataForDisplay(text: string): string {
  return stripInboundMetadata(stripInternalRuntimeContext(text));
}
