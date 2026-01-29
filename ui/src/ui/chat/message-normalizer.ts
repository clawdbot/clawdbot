/**
 * Message normalization utilities for chat rendering.
 */

import type {
  NormalizedMessage,
  MessageContentItem,
} from "../types/chat-types";

/**
 * Normalize a raw message object into a consistent structure.
 */
export function normalizeMessage(message: unknown): NormalizedMessage {
  const m = message as Record<string, unknown>;
  let role = typeof m.role === "string" ? m.role : "unknown";

  // Detect tool messages by common gateway shapes.
  // Some tool events come through as assistant role with tool_* items in the content array.
  const hasToolId =
    typeof m.toolCallId === "string" || typeof m.tool_call_id === "string";

  const contentRaw = m.content;
  const contentItems = Array.isArray(contentRaw) ? contentRaw : null;
  const hasToolContent =
    Array.isArray(contentItems) &&
    contentItems.some((item) => {
      const x = item as Record<string, unknown>;
      const t = String(x.type ?? "").toLowerCase();
      return t === "toolresult" || t === "tool_result";
    });

  const hasToolName =
    typeof (m as Record<string, unknown>).toolName === "string" ||
    typeof (m as Record<string, unknown>).tool_name === "string";

  if (hasToolId || hasToolContent || hasToolName) {
    role = "toolResult";
  }

  // Extract content
  let content: MessageContentItem[] = [];

  if (typeof m.content === "string") {
    content = [{ type: "text", text: m.content }];
  } else if (Array.isArray(m.content)) {
    content = m.content.map((item: Record<string, unknown>) => ({
      type: (item.type as MessageContentItem["type"]) || "text",
      text: item.text as string | undefined,
      name: item.name as string | undefined,
      args: item.args || item.arguments,
    }));
  } else if (typeof m.text === "string") {
    content = [{ type: "text", text: m.text }];
  }

  const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  const id = typeof m.id === "string" ? m.id : undefined;

  return { role, content, timestamp, id };
}

type SplitSystemMessageResult = {
  systemMessage: NormalizedMessage | null;
  message: NormalizedMessage;
};

const SYSTEM_LINE_PREFIX = "System: ";

function parseSystemLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(SYSTEM_LINE_PREFIX)) return null;
  const payload = trimmed.slice(SYSTEM_LINE_PREFIX.length).trim();
  return payload ? payload : null;
}

export function splitSystemPreface(
  message: NormalizedMessage,
): SplitSystemMessageResult {
  if (message.role.toLowerCase() !== "user") {
    return { systemMessage: null, message };
  }

  const textParts = message.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .filter((text) => text.trim().length > 0);

  if (textParts.length === 0) return { systemMessage: null, message };

  const joined = textParts.join("\n").trim();
  if (!joined.startsWith(SYSTEM_LINE_PREFIX)) {
    return { systemMessage: null, message };
  }

  const lines = joined.split(/\r?\n/);
  const systemLines: string[] = [];
  let idx = 0;
  while (idx < lines.length) {
    const parsed = parseSystemLine(lines[idx] ?? "");
    if (!parsed) break;
    systemLines.push(parsed);
    idx += 1;
  }

  if (systemLines.length === 0) return { systemMessage: null, message };

  // Skip blank separator line after system block, if present.
  while (idx < lines.length && !lines[idx]?.trim()) idx += 1;
  const remainder = lines.slice(idx).join("\n").trim();

  const systemMessage: NormalizedMessage = {
    role: "system",
    content: [{ type: "text", text: systemLines.join("\n") }],
    timestamp: message.timestamp,
  };

  if (!remainder) {
    return { systemMessage, message: { ...message, content: [] } };
  }

  return {
    systemMessage,
    message: {
      ...message,
      content: [{ type: "text", text: remainder }],
    },
  };
}

/**
 * Normalize role for grouping purposes.
 */
export function normalizeRoleForGrouping(role: string): string {
  const lower = role.toLowerCase();
  // Preserve original casing when it's already a core role.
  if (role === "user" || role === "User") return role;
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
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
