// OpenResponses file-content boundary helper.
// Marks uploaded/read file text as untrusted external model input.
import { wrapExternalContent } from "../security/external-content.js";

// OpenResponses file content is untrusted model input. The wrapper preserves
// content while marking it as external so prompt assembly keeps the boundary.
/** Wraps untrusted file content for OpenResponses input blocks. */
export function wrapUntrustedFileContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}
