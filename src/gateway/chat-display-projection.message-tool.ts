import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  isProjectedSessionsSendForwardedMessage,
  isSessionsSendInterSessionUserMessage,
} from "./chat-display-projection.helpers.js";
import { displayTextForDuplicateCheck } from "./chat-display-projection.history.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

type PendingMessageToolVisibleReply = {
  toolCallId?: string;
  text: string;
  requiresSourceRouteConfirmation: boolean;
  anchor: Record<string, unknown>;
  completionAnchor?: Record<string, unknown>;
  deliveryMirrorAnchor?: Record<string, unknown>;
  deliveryMirrorIndex?: number;
  sourceReplySink?: "internal-ui";
  succeeded: boolean;
};

function normalizeToolHistoryType(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized ? normalized.replace(/_/g, "") : undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readMaybeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return parseJsonRecord(value);
  }
  return readRecord(value);
}

function readToolBlockName(block: Record<string, unknown>): string | undefined {
  const direct =
    normalizeOptionalString(block.name) ??
    normalizeOptionalString(block.toolName) ??
    normalizeOptionalString(block.tool_name) ??
    normalizeOptionalString(block.tool);
  if (direct) {
    return direct;
  }
  const fn = readRecord(block.function);
  return fn ? normalizeOptionalString(fn.name) : undefined;
}

function readToolBlockCallId(block: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(block.id) ??
    normalizeOptionalString(block.toolCallId) ??
    normalizeOptionalString(block.tool_call_id) ??
    normalizeOptionalString(block.callId) ??
    normalizeOptionalString(block.call_id)
  );
}

function readToolBlockArguments(block: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["arguments", "input", "args", "params"] as const) {
    const args = readMaybeJsonRecord(block[key]);
    if (args) {
      return args;
    }
  }
  const fn = readRecord(block.function);
  if (fn) {
    const args = readMaybeJsonRecord(fn.arguments);
    if (args) {
      return args;
    }
  }
  return {};
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some(hasNonEmptyValue);
  }
  if (!value || typeof value !== "object") {
    return value != null;
  }
  return Object.values(value as Record<string, unknown>).some(hasNonEmptyValue);
}

function hasExplicitMessageToolRoute(args: Record<string, unknown>): boolean {
  // Channel/provider select the transport; only concrete target ids move the send off-chat.
  const routeFields = [
    "target",
    "targets",
    "to",
    "recipient",
    "recipients",
    "chatId",
    "chat_id",
    "channelId",
    "channel_id",
    "conversationId",
    "conversation_id",
    "threadId",
    "thread_id",
    "roomId",
    "room_id",
    "groupId",
    "group_id",
  ];
  return routeFields.some((field) => hasNonEmptyValue(args[field]));
}

function readMessageToolVisibleText(args: Record<string, unknown>): string | undefined {
  for (const field of ["message", "text", "content", "body", "caption"] as const) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) {
      return stripInlineDirectiveTagsForDisplay(value).text;
    }
  }
  return undefined;
}

function isDryRunMessageToolRecord(record: Record<string, unknown>): boolean {
  if (record.dryRun === true || record.dry_run === true) {
    return true;
  }
  const deliveryStatus =
    normalizeOptionalString(record.deliveryStatus) ??
    normalizeOptionalString(record.delivery_status) ??
    normalizeOptionalString(record.status);
  return deliveryStatus?.toLowerCase() === "dry_run";
}

function extractMessageToolVisibleReplies(
  message: Record<string, unknown>,
): Array<Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded">> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const replies: Array<Omit<PendingMessageToolVisibleReply, "anchor" | "succeeded">> = [];
  for (const block of message.content) {
    const record = readRecord(block);
    if (!record) {
      continue;
    }
    const type = normalizeToolHistoryType(record.type);
    if (type !== "toolcall" && type !== "tooluse") {
      continue;
    }
    if (readToolBlockName(record)?.toLowerCase() !== "message") {
      continue;
    }
    const args = readToolBlockArguments(record);
    if (normalizeOptionalString(args.action)?.toLowerCase() !== "send") {
      continue;
    }
    if (isDryRunMessageToolRecord(args)) {
      continue;
    }
    const requiresSourceRouteConfirmation = hasExplicitMessageToolRoute(args);
    const text = readMessageToolVisibleText(args);
    if (!text?.trim()) {
      continue;
    }
    const toolCallId = readToolBlockCallId(record);
    replies.push({
      ...(toolCallId ? { toolCallId } : {}),
      text,
      requiresSourceRouteConfirmation,
    });
  }
  return replies;
}

function isAssistantSilentControlReplyOnly(message: Record<string, unknown>): boolean {
  const text = extractAssistantTextForSilentCheck(message);
  return (
    text !== undefined &&
    isSuppressedControlReplyText(text) &&
    !hasAssistantDisplayableNonTextContent(message)
  );
}

function isRenderableAssistantDisplayMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const text = extractAssistantTextForSilentCheck(message);
  return text !== undefined && !isSuppressedControlReplyText(text);
}

function readMessageToolResultName(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolName) ??
    normalizeOptionalString(message.tool_name) ??
    normalizeOptionalString(message.name) ??
    normalizeOptionalString(message.tool)
  );
}

function readMessageToolResultCallId(message: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(message.toolCallId) ??
    normalizeOptionalString(message.tool_call_id) ??
    normalizeOptionalString(message.callId) ??
    normalizeOptionalString(message.call_id) ??
    normalizeOptionalString(message.id)
  );
}

function readToolResultOkValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const record = readMaybeJsonRecord(value);
  if (record && typeof record.ok === "boolean") {
    return record.ok;
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const blockOk = readToolResultOkValue(block);
      if (blockOk !== undefined) {
        return blockOk;
      }
      const recordBlock = readRecord(block);
      if (typeof recordBlock?.text === "string") {
        const textOk = readToolResultOkValue(recordBlock.text);
        if (textOk !== undefined) {
          return textOk;
        }
      }
      if (typeof recordBlock?.content === "string") {
        const contentOk = readToolResultOkValue(recordBlock.content);
        if (contentOk !== undefined) {
          return contentOk;
        }
      }
    }
  }
  return undefined;
}

function hasDryRunToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record && isDryRunMessageToolRecord(record)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasDryRunToolResultValue(block)) {
      return true;
    }
    const recordBlock = readRecord(block);
    if (typeof recordBlock?.text === "string" && hasDryRunToolResultValue(recordBlock.text)) {
      return true;
    }
    return (
      typeof recordBlock?.content === "string" && hasDryRunToolResultValue(recordBlock.content)
    );
  });
}

function hasSuppressedToolResultValue(value: unknown): boolean {
  const record = readMaybeJsonRecord(value);
  if (record) {
    const messageId = normalizeOptionalString(record.messageId)?.toLowerCase();
    const status = (
      normalizeOptionalString(record.deliveryStatus) ??
      normalizeOptionalString(record.delivery_status) ??
      normalizeOptionalString(record.status)
    )?.toLowerCase();
    if (
      record.delivered === false ||
      messageId === "skipped" ||
      messageId === "suppressed" ||
      status === "skipped" ||
      status === "suppressed"
    ) {
      return true;
    }
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((block) => {
    if (hasSuppressedToolResultValue(block)) {
      return true;
    }
    const blockRecord = readRecord(block);
    return (
      hasSuppressedToolResultValue(blockRecord?.text) ||
      hasSuppressedToolResultValue(blockRecord?.content)
    );
  });
}

function isSuccessfulMessageToolResult(
  message: Record<string, unknown>,
  pending: PendingMessageToolVisibleReply,
): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase().replace(/_/g, "") : "";
  const toolName = readMessageToolResultName(message)?.toLowerCase();
  if (role !== "toolresult" && role !== "tool" && role !== "function" && toolName !== "message") {
    return false;
  }
  if (toolName && toolName !== "message") {
    return false;
  }
  const resultCallId = readMessageToolResultCallId(message);
  const hasConfirmedSourceRoute =
    !pending.requiresSourceRouteConfirmation ||
    readRecord(message.details)?.sourceReplyRoute === "current-source";
  if (pending.toolCallId) {
    return (
      resultCallId === pending.toolCallId &&
      isSuccessfulMessageToolResultPayload(message) &&
      hasConfirmedSourceRoute
    );
  }
  return isSuccessfulMessageToolResultPayload(message) && hasConfirmedSourceRoute;
}

function isSuccessfulMessageToolResultPayload(message: Record<string, unknown>): boolean {
  if (message.isError === true || (message.error != null && message.error !== false)) {
    return false;
  }
  if (
    hasDryRunToolResultValue(message.result) ||
    hasDryRunToolResultValue(message.output) ||
    hasDryRunToolResultValue(message.content) ||
    hasDryRunToolResultValue(message.text)
  ) {
    return false;
  }
  if (
    hasSuppressedToolResultValue(message.details) ||
    hasSuppressedToolResultValue(message.result) ||
    hasSuppressedToolResultValue(message.output) ||
    hasSuppressedToolResultValue(message.content) ||
    hasSuppressedToolResultValue(message.text)
  ) {
    return false;
  }
  const ok =
    readToolResultOkValue(message.result) ??
    readToolResultOkValue(message.output) ??
    readToolResultOkValue(message.content) ??
    readToolResultOkValue(message.text);
  return ok !== false;
}

function readMessageToolSourceReplySink(
  message: Record<string, unknown>,
): "internal-ui" | undefined {
  const details = readRecord(message.details);
  return details?.sourceReplySink === "internal-ui" ? "internal-ui" : undefined;
}

function buildMessageToolVisibleReplyMirror(
  pending: PendingMessageToolVisibleReply,
): Record<string, unknown> {
  const sourceMessageSeq = asPositiveSafeInteger(readRecord(pending.anchor["__openclaw"])?.seq);
  const mirror: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: pending.text }],
    openclawMessageToolMirror: {
      toolName: "message",
      ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
      ...(pending.sourceReplySink ? { sourceReplySink: pending.sourceReplySink } : {}),
      ...(pending.sourceReplySink && sourceMessageSeq ? { sourceMessageSeq } : {}),
    },
  };
  for (const field of ["timestamp", "createdAt", "agentId"] as const) {
    if (pending.anchor[field] !== undefined) {
      mirror[field] = pending.anchor[field];
    }
  }
  const transcriptMeta = readRecord((pending.completionAnchor ?? pending.anchor)["__openclaw"]);
  if (transcriptMeta) {
    mirror["__openclaw"] = { ...transcriptMeta };
  }
  return mirror;
}

function readMessageToolDeliveryMirrorText(message: Record<string, unknown>): string | undefined {
  // Delivery mirrors can arrive between a successful message-tool result and
  // the final NO_REPLY. The pending mirror is the display row; the raw mirror
  // would duplicate that same send.
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return undefined;
  }
  return displayTextForDuplicateCheck(message);
}

export function mirrorMessageToolVisibleReplies(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  if (!messages.some((message) => readRecord(message))) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  const pending: PendingMessageToolVisibleReply[] = [];

  const clearPending = () => {
    if (pending.length > 0) {
      pending.length = 0;
    }
  };

  const flushSucceededMirrors = () => {
    for (const item of pending) {
      if (!item.succeeded) {
        continue;
      }
      next.push(buildMessageToolVisibleReplyMirror(item));
      changed = true;
    }
    clearPending();
  };

  const flushSelectedMirrors = (items: PendingMessageToolVisibleReply[]) => {
    if (items.length === 0) {
      return;
    }
    const selected = new Set(items);
    const remaining: PendingMessageToolVisibleReply[] = [];
    for (const item of pending) {
      if (selected.has(item) && item.succeeded) {
        next.push(buildMessageToolVisibleReplyMirror(item));
        changed = true;
        continue;
      }
      remaining.push(item);
    }
    pending.length = 0;
    pending.push(...remaining);
  };

  for (const message of messages) {
    const record = readRecord(message);
    if (!record) {
      next.push(message);
      continue;
    }

    if (
      (record.role === "user" && isSessionsSendInterSessionUserMessage(record)) ||
      isProjectedSessionsSendForwardedMessage(record)
    ) {
      next.push(message);
      continue;
    }

    if (record.role === "user") {
      clearPending();
      next.push(message);
      continue;
    }

    const flushAfterCurrentMessage: PendingMessageToolVisibleReply[] = [];
    const deliveryMirrorText = readMessageToolDeliveryMirrorText(record);
    const matchingDeliveryMirrorPending = deliveryMirrorText
      ? pending.filter((item) => item.text.trim() === deliveryMirrorText)
      : [];
    const duplicateDeliveryMirror = matchingDeliveryMirrorPending.some((item) => item.succeeded);
    const visibleReplies = extractMessageToolVisibleReplies(record);
    if (visibleReplies.length > 0) {
      for (const reply of visibleReplies) {
        pending.push({
          ...reply,
          anchor: record,
          succeeded: false,
        });
      }
    } else if (
      matchingDeliveryMirrorPending.length === 0 &&
      isRenderableAssistantDisplayMessage(record)
    ) {
      clearPending();
    }

    if (pending.length > 0) {
      for (const item of pending) {
        if (!item.succeeded && isSuccessfulMessageToolResult(record, item)) {
          item.succeeded = true;
          const sourceReplySink = readMessageToolSourceReplySink(record);
          if (sourceReplySink) {
            item.sourceReplySink = sourceReplySink;
          }
          item.completionAnchor = item.deliveryMirrorAnchor ?? record;
          if (item.deliveryMirrorAnchor) {
            if (typeof item.deliveryMirrorIndex === "number") {
              next[item.deliveryMirrorIndex] = { ...item.deliveryMirrorAnchor, display: false };
            }
            flushAfterCurrentMessage.push(item);
          }
        }
      }
      if (isAssistantSilentControlReplyOnly(record)) {
        flushSucceededMirrors();
      }
    }

    if (duplicateDeliveryMirror) {
      for (const item of matchingDeliveryMirrorPending) {
        item.completionAnchor = record;
      }
      flushSelectedMirrors(matchingDeliveryMirrorPending);
      changed = true;
      continue;
    }

    for (const item of matchingDeliveryMirrorPending) {
      item.deliveryMirrorAnchor = record;
      item.deliveryMirrorIndex = next.length;
    }
    next.push(message);
    flushSelectedMirrors(flushAfterCurrentMessage);
  }

  return changed ? next : messages;
}
