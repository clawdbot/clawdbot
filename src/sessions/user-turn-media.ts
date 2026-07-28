import { isMeaningfulMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";

// Model-facing marker for user turns that carry media but no caption. Never
// persist it as transcript content — UIs render content verbatim; the LLM
// boundary (normalizeMessagesForLlmBoundary) injects it for blank media turns.
export const MEDIA_ONLY_USER_TEXT = "[User sent media without caption]";

export function hasPersistedMedia(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  return (readPersistedMediaFacts(message) ?? []).some(isMeaningfulMediaFact);
}
