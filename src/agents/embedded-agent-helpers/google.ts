import { isGemma4ModelId } from "../../shared/google-models.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

/** Detects Google-owned embedded runtime APIs. */
export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

/** Returns true for Gemma models whose reasoning payload must be stripped. */
export function isGemma4ModelRequiringReasoningStrip(modelId?: string | null): boolean {
  return isGemma4ModelId(modelId);
}

// Re-exported from the helper barrel so Google-specific callers do not import
// bootstrap internals directly.
export { sanitizeGoogleTurnOrdering };
