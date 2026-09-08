import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";

/** Tracks actual native items for explicit terminal-tool batching. */
export function updateActiveTurnItemIds(
  notification: CodexServerNotification,
  activeItemIds: Set<string>,
): void {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId) {
    return;
  }
  if (notification.method === "item/started") {
    activeItemIds.add(itemId);
    return;
  }
  activeItemIds.delete(itemId);
}

/** Reads an item id from supported notification envelope shapes. */
export function readNotificationItemId(notification: CodexServerNotification): string | undefined {
  if (!isJsonObject(notification.params)) {
    return undefined;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return (
    (item ? readString(item, "id") : undefined) ??
    readString(notification.params, "itemId") ??
    readString(notification.params, "id")
  );
}

/** Detects completion for an OpenClaw dynamic tool result still awaited by Codex. */
export function isPendingOpenClawDynamicToolCompletionNotification(
  notification: CodexServerNotification,
  pendingOpenClawDynamicToolCompletionIds: ReadonlySet<string>,
): boolean {
  if (notification.method !== "item/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId || !pendingOpenClawDynamicToolCompletionIds.has(itemId)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  const itemType = item ? readString(item, "type") : undefined;
  return itemType === undefined || itemType === "dynamicToolCall";
}

export function isRawFunctionToolOutputCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return item ? readString(item, "type") === "function_call_output" : false;
}

/** Distinguishes progress-only assistant items from conversation answers. */
export function isAssistantCommentaryCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (!isJsonObject(notification.params) || notification.method !== "item/completed") {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(
    item &&
    readString(item, "type") === "agentMessage" &&
    (readString(item, "phase") === "commentary" || readString(item, "delivery") === "async"),
  );
}

/** Returns true for terminal app-server thread status strings. */
export function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

/** Detects Codex's interrupted-turn marker, not user-authored copies of it. */
export function isCodexTurnAbortMarkerNotification(
  notification: CodexServerNotification,
  options: {
    currentPromptText?: string;
    currentPromptTexts?: readonly string[];
  } = {},
): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = notification.params.item;
  const role = isJsonObject(item) ? readString(item, "role") : undefined;
  if (
    !isJsonObject(item) ||
    readString(item, "type") !== "message" ||
    (role !== "user" && role !== "developer")
  ) {
    return false;
  }
  const text = extractRawResponseItemText(item).trim();
  const currentPromptTexts = [options.currentPromptText, ...(options.currentPromptTexts ?? [])]
    .filter(isNonEmptyString)
    .map((prompt) => prompt.trim());
  if (role === "user" && currentPromptTexts.includes(text)) {
    return false;
  }
  return readCodexTurnAbortMarkerBody(text) !== undefined;
}

function readCodexTurnAbortMarkerBody(text: string): string | undefined {
  if (
    !text.startsWith(CODEX_TURN_ABORT_MARKER_START) ||
    !text.endsWith(CODEX_TURN_ABORT_MARKER_END)
  ) {
    return undefined;
  }
  return text
    .slice(CODEX_TURN_ABORT_MARKER_START.length, -CODEX_TURN_ABORT_MARKER_END.length)
    .trim();
}

function extractRawResponseItemText(item: JsonObject): string {
  const content = item.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const type = readString(entry, "type");
      if (type !== "input_text" && type !== "text") {
        return [];
      }
      const text = readString(entry, "text");
      return text ? [text] : [];
    })
    .join("");
}

/** Reads a typed Codex item from notification params when id/type are present. */
export function readCodexNotificationItem(
  params: JsonValue | undefined,
): CodexThreadItem | undefined {
  if (!isJsonObject(params) || !isJsonObject(params.item)) {
    return undefined;
  }
  const item = params.item;
  return typeof item.id === "string" && typeof item.type === "string"
    ? (item as CodexThreadItem)
    : undefined;
}

/** Reads the stable call id from a model-emitted raw tool item. */
export function readRawResponseToolCallId(
  notification: CodexServerNotification,
): string | undefined {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return undefined;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  if (!item) {
    return undefined;
  }
  switch (readString(item, "type")) {
    case "custom_tool_call":
    case "function_call":
    case "local_shell_call":
    case "tool_search_call":
      return readString(item, "call_id");
    case "image_generation_call":
    case "web_search_call":
      return readString(item, "id");
    default:
      return undefined;
  }
}

/** Maps Codex item types to the tool name shown in execution progress. */
export function codexExecutionToolName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return item.tool;
  }
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" && item.server ? item.server : undefined;
    return server ? `${server}.${item.tool}` : item.tool;
  }
  if (item.type === "commandExecution") {
    return "bash";
  }
  if (item.type === "fileChange") {
    return "apply_patch";
  }
  if (item.type === "webSearch") {
    return "web_search";
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
