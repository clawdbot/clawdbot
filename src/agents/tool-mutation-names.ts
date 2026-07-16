import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch",
  "exec",
  "bash",
  "process",
  "message",
  "sessions",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "canvas",
  "computer",
  "nodes",
  "session_status",
  "create_goal",
  "update_goal",
]);

export function isLikelyMutatingToolName(toolName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return Boolean(
    normalized &&
    (MUTATING_TOOL_NAMES.has(normalized) ||
      normalized.endsWith("_actions") ||
      normalized.startsWith("message_") ||
      normalized.includes("send")),
  );
}
