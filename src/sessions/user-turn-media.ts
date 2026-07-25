// Model-facing marker for user turns that carry media but no caption. Never
// persist it as transcript content — UIs render content verbatim; the LLM
// boundary (normalizeMessagesForLlmBoundary) injects it for blank media turns.
export const MEDIA_ONLY_USER_TEXT = "[User sent media without caption]";

export function hasPersistedMedia(message: unknown): boolean {
  const media = message as Record<string, unknown>;
  return [media.MediaPath, media.MediaPaths, media.MediaUrl, media.MediaUrls]
    .flat()
    .some((value) => typeof value === "string" && Boolean(value.trim()));
}
