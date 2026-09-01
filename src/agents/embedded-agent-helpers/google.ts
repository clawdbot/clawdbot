/**
 * Google/Gemini-specific embedded-agent runtime helpers.
 */
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

/** Detects Google-owned embedded runtime APIs. */
export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

// Re-exported from the helper barrel so Google-specific callers do not import
// bootstrap internals directly.
export { sanitizeGoogleTurnOrdering };
