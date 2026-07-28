export function resolveLogicalPlannedToolName(
  plannedToolName: string | undefined,
  plannedToolArgs: Record<string, unknown> | undefined,
) {
  if (!plannedToolName || plannedToolName !== "exec") {
    return plannedToolName;
  }
  const code =
    typeof plannedToolArgs?.code === "string"
      ? plannedToolArgs.code
      : typeof plannedToolArgs?.command === "string"
        ? plannedToolArgs.command
        : "";
  const toolId = /\btools\.call(?:Value)?\s*\(\s*["']([^"']+)["']/u.exec(code)?.[1];
  if (!toolId) {
    return plannedToolName;
  }
  return /^openclaw:core:([a-z][a-z0-9_-]*)$/u.exec(toolId)?.[1] || plannedToolName;
}
