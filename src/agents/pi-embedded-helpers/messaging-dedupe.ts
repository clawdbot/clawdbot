const MIN_DUPLICATE_TEXT_LENGTH = 10;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) return false;
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
    return false;
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH)
      return false;
    return (
      normalized.includes(normalizedSent) || normalizedSent.includes(normalized)
    );
  });
}

export function isMessagingToolDuplicate(
  text: string,
  sentTexts: string[],
): boolean {
  if (sentTexts.length === 0) return false;
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH)
    return false;
  return isMessagingToolDuplicateNormalized(
    normalized,
    sentTexts.map(normalizeTextForComparison),
  );
}
