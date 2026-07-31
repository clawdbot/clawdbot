import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  AUTOMATIONS_TOOL_NAME,
  LEGACY_AUTOMATIONS_TOOL_NAMES,
} from "./tools/automations-tool-name.js";

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
  AUTOMATIONS_TOOL_NAME,
  // Saved transcripts predate the rename; legacy names must stay classified.
  ...LEGACY_AUTOMATIONS_TOOL_NAMES,
  "gateway",
  "canvas",
  "computer",
  "mobile_ui",
  "conversations_send",
  "conversations_turn",
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
