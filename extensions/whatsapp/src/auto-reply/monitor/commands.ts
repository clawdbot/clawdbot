export function stripMentionsForCommand(
  text: string,
  mentionRegexes: RegExp[],
  selfE164?: string | null,
) {
  let result = text;
  for (const re of mentionRegexes) {
    result = result.replace(re, " ");
  }
  if (selfE164) {
    // `selfE164` is usually like "+1234"; strip down to digits so we can match "+?1234" safely.
    const digits = selfE164.replace(/\D/g, "");
    if (digits) {
      const pattern = new RegExp(`\\+?${digits}`, "g");
      result = result.replace(pattern, " ");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}
