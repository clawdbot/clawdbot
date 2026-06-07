/**
 * Predicates and readers for Codex app-server notification envelopes.
 */
import { asBoolean } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  describeCodexNotificationCorrelation,
  isCodexNotificationForTurn,
} from "./notification-correlation.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";
const CODEX_INTERRUPTED_USER_GUIDANCE =
  "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const CODEX_INTERRUPTED_DEVELOPER_GUIDANCE =
  "The previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";

/** Builds compact activity metadata for watchdog and diagnostic updates. */
export function describeNotificationActivity(
  notification: CodexServerNotification,
): Record<string, unknown> | undefined {
  if (!isJsonObject(notification.params)) {
    return { lastNotificationMethod: notification.method };
  }
  if (notification.method !== "rawResponseItem/completed") {
    return { lastNotificationMethod: notification.method };
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  if (!item) {
    return { lastNotificationMethod: notification.method };
  }
  return {
    lastNotificationMethod: notification.method,
    lastNotificationItemId: readString(item, "id"),
    lastNotificationItemType: readString(item, "type"),
    lastNotificationItemRole: readString(item, "role"),
    lastAssistantTextPreview: readRawAssistantTextPreview(item),
  };
}

/** Tracks active app-server item ids from item start/completion notifications. */
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

function isCompletedAssistantNotification(notification: CodexServerNotification): boolean {
  if (!isJsonObject(notification.params)) {
    return false;
  }
  if (notification.method !== "item/completed") {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(
    item &&
    readString(item, "type") === "agentMessage" &&
    readString(item, "phase") !== "commentary",
  );
}

/** Returns true for completed app-server reasoning items. */
export function isReasoningItemCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (!isJsonObject(notification.params) || notification.method !== "item/completed") {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return item ? readString(item, "type") === "reasoning" : false;
}

/** Returns true for completed assistant commentary items. */
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
    readString(item, "phase") === "commentary",
  );
}

/** Returns true for completed raw response reasoning items. */
export function isRawReasoningCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (!isJsonObject(notification.params) || notification.method !== "rawResponseItem/completed") {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return item ? readString(item, "type") === "reasoning" : false;
}

/** Returns true for streamed app-server reasoning progress. */
export function isReasoningProgressNotification(notification: CodexServerNotification): boolean {
  return (
    notification.method === "item/reasoning/textDelta" ||
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/summaryPartAdded"
  );
}

/** Returns true when assistant completion can release the short idle watch. */
export function isAssistantCompletionReleaseNotification(
  notification: CodexServerNotification,
  turnCrossedToolHandoff: boolean,
): boolean {
  if (isCompletedAssistantNotification(notification)) {
    return true;
  }
  return !turnCrossedToolHandoff && isRawAssistantCompletionNotification(notification);
}

/** Returns true when a notification proves assistant output is still active. */
export function shouldDisarmAssistantCompletionIdleWatch(
  notification: CodexServerNotification,
): boolean {
  if (!isJsonObject(notification.params)) {
    return false;
  }
  if (notification.method === "item/started") {
    return true;
  }
  if (notification.method === "item/agentMessage/delta") {
    return true;
  }
  return false;
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

/** Returns true for raw response tool-output completion notifications. */
export function isRawToolOutputCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return item ? readString(item, "type") === "custom_tool_call_output" : false;
}

/** Returns true for progress on Codex-native tool item types. */
export function isNativeToolProgressNotification(notification: CodexServerNotification): boolean {
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed" &&
    notification.method !== "item/updated"
  ) {
    return false;
  }
  if (!isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  switch (item ? readString(item, "type") : undefined) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return true;
    default:
      return false;
  }
}

/** Returns true for raw native response stream delta events. */
export function isNativeResponseStreamDeltaNotification(
  notification: CodexServerNotification,
): boolean {
  return notification.method.startsWith("response.") && notification.method.endsWith(".delta");
}

/** Returns true for file-change patch update notifications. */
export function isFileChangePatchUpdatedNotification(
  notification: CodexServerNotification,
): boolean {
  return (
    notification.method === "item/fileChange/patchUpdated" && isJsonObject(notification.params)
  );
}

/** Returns true for raw assistant message progress with readable text. */
export function isRawAssistantProgressNotification(notification: CodexServerNotification): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(
    item &&
    readString(item, "type") === "message" &&
    readString(item, "role") === "assistant" &&
    readRawAssistantTextPreview(item),
  );
}

/** Returns true for raw assistant completion outside commentary phase. */
export function isRawAssistantCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  if (!isRawAssistantProgressNotification(notification) || !isJsonObject(notification.params)) {
    return false;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return Boolean(item && readString(item, "phase") !== "commentary");
}

function readRawAssistantTextPreview(item: JsonObject): string | undefined {
  if (readString(item, "role") !== "assistant" || !Array.isArray(item.content)) {
    return undefined;
  }
  const text = item.content
    .flatMap((content) => {
      if (!isJsonObject(content)) {
        return [];
      }
      const contentText = readString(content, "text");
      return contentText ? [contentText] : [];
    })
    .join("\n")
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

/** Returns true when notification params correlate to a specific thread/turn. */
export function isTurnNotification(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  return isCodexNotificationForTurn(value, threadId, turnId);
}

/** Returns true when a correlated notification belongs to another active run. */
export function isCodexNotificationOutsideActiveRun(
  correlation: ReturnType<typeof describeCodexNotificationCorrelation>,
): boolean {
  const hasThreadScope = Boolean(correlation.threadId || correlation.nestedTurnThreadId);
  if (!hasThreadScope) {
    return false;
  }
  if (!correlation.matchesActiveThread) {
    return true;
  }
  const hasTurnScope = Boolean(correlation.turnId || correlation.nestedTurnId);
  return hasTurnScope && correlation.matchesActiveTurn === false;
}

/** Checks request params that must contain the current thread and turn ids. */
export function isCurrentThreadTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readString(value, "threadId") === threadId && readString(value, "turnId") === turnId;
}

/** Checks approval request params, accepting `conversationId` as thread id. */
export function isCurrentApprovalTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  const requestThreadId = readString(value, "threadId") ?? readString(value, "conversationId");
  return requestThreadId === threadId && readString(value, "turnId") === turnId;
}

/** Checks request params where `turnId` may be omitted or null for the thread. */
export function isCurrentThreadOptionalTurnRequestParams(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value) || readString(value, "threadId") !== threadId) {
    return false;
  }
  const requestTurnId = value.turnId;
  return requestTurnId === null || requestTurnId === undefined || requestTurnId === turnId;
}

/** Returns true for app-server error notifications that will retry. */
export function isRetryableErrorNotification(value: JsonValue | undefined): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readBoolean(value, "willRetry") === true || readBoolean(value, "will_retry") === true;
}

/** Returns true for terminal app-server thread status strings. */
export function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

/**
 * Detects Codex's synthetic interrupted-turn marker while ignoring the current
 * user prompt echoed through raw response events.
 */
export function isCodexTurnAbortMarkerNotification(
  notification: CodexServerNotification,
  options: { currentPromptText?: string; currentPromptTexts?: readonly string[] } = {},
): boolean {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return false;
  }
  const item = notification.params.item;
  const role = isJsonObject(item) ? readString(item, "role") : undefined;
  if (!isJsonObject(item) || (role !== "user" && role !== "developer")) {
    return false;
  }
  const text = extractRawResponseItemText(item).trim();
  const currentPromptTexts = [options.currentPromptText, ...(options.currentPromptTexts ?? [])]
    .filter(isNonEmptyString)
    .map((prompt) => prompt.trim());
  if (role === "user" && currentPromptTexts.includes(text)) {
    return false;
  }
  const markerBody = readCodexTurnAbortMarkerBody(text);
  return (
    markerBody === CODEX_INTERRUPTED_USER_GUIDANCE ||
    markerBody === CODEX_INTERRUPTED_DEVELOPER_GUIDANCE
  );
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

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(record: JsonObject, key: string): boolean | undefined {
  return asBoolean(record[key]);
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
