const CLAUDE_SESSION_CURSOR_MAX_LENGTH = 256;

export function isExactClaudeSessionCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CLAUDE_SESSION_CURSOR_MAX_LENGTH &&
    value === value.trim()
  );
}
