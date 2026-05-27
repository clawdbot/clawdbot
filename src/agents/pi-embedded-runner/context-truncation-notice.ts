export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "more characters truncated";
const CONTEXT_LIMIT_TRUNCATION_HINT = "rerun with narrower args if needed";

export function formatContextLimitTruncationNotice(truncatedChars: number): string {
  return (
    `[... ${Math.max(1, Math.floor(truncatedChars))} ${CONTEXT_LIMIT_TRUNCATION_NOTICE}; ` +
    `${CONTEXT_LIMIT_TRUNCATION_HINT}]`
  );
}
