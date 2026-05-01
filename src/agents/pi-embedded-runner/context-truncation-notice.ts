export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";

export function formatContextLimitTruncationNotice(truncatedChars: number): string {
  return `[... ${Math.max(1, Math.floor(truncatedChars))} ${CONTEXT_LIMIT_TRUNCATION_NOTICE}]`;
}
