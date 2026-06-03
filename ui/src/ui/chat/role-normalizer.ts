/**
 * Normalize role for grouping purposes.
 */
export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  // Core roles drive grouping and layout; casing variants should not split groups.
  if (lower === "user") {
    return "user";
  }
  if (lower === "assistant") {
    return "assistant";
  }
  if (lower === "system") {
    return "system";
  }
  // Keep tool-related roles distinct so the UI can style/toggle them.
  if (
    lower === "toolresult" ||
    lower === "tool_result" ||
    lower === "tool" ||
    lower === "function"
  ) {
    return "tool";
  }
  return role;
}

/**
 * Check if a message is a tool result message based on its role.
 */
export function isToolResultMessage(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role.toLowerCase() : "";
  return role === "toolresult" || role === "tool_result";
}
