/**
 * Detects message-tool sends that delivered a visible reply to the current source.
 */
import { safeParseJson } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString, readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import {
  isMessageToolConversationCreateActionName,
  isMessageToolSendActionName,
  isMessagingToolDeliveryAction,
} from "./embedded-agent-messaging.js";
import { isToolResultError } from "./embedded-agent-subscribe.tools.js";
import { normalizeToolName } from "./tool-policy.js";

const MESSAGE_TOOL_NAME = "message";
const SESSIONS_SEND_TOOL_NAME = "sessions_send";
const EXPLICIT_MESSAGE_ROUTE_KEYS = ["channel", "target", "to", "channelId", "provider"];
const DRY_RUN_DELIVERY_STATUS = "dry_run";
const PARTIAL_FAILED_DELIVERY_STATUS = "partial_failed";
const SENT_DELIVERY_STATUS = "sent";
const NON_DELIVERY_MESSAGE_IDS = new Set(["skipped", "suppressed"]);
const RESULT_ENVELOPE_KEYS = [
  "details",
  "payload",
  "result",
  "results",
  "sendResult",
  "toolResult",
];
const BROADCAST_SEND_ENVELOPE_KEYS = ["payload", "result", "sendResult", "toolResult"];
const PARTIAL_DELIVERY_ENVELOPE_KEYS = [...RESULT_ENVELOPE_KEYS, "error", "cause"];
const SESSIONS_SEND_DELIVERY_STATUSES = new Set(["accepted", "ok"]);
const BARE_OK_DELIVERY_STATUS = "ok";

/** Omission preserves the established one-shot send behavior. */
export function resolveMessageToolSourceReplyFinal(args: unknown): boolean {
  return (asOptionalRecord(args) ?? {}).final !== false;
}

function resultConfirmsCurrentSourceRoute(value: unknown): boolean {
  return (
    (asOptionalRecord(asOptionalRecord(value)?.details) ?? {}).sourceReplyRoute === "current-source"
  );
}

function hasConversationIdValue(value: unknown): boolean {
  return hasNonEmptyString(value) || (typeof value === "number" && Number.isFinite(value));
}

function hasExplicitMessageRoute(args: Record<string, unknown>): boolean {
  if (EXPLICIT_MESSAGE_ROUTE_KEYS.some((key) => hasNonEmptyString(args[key]))) {
    return true;
  }
  return Array.isArray(args.targets) && args.targets.some((value) => hasNonEmptyString(value));
}

function isMessageToolSourceReplyActionName(action: unknown): boolean {
  if (isMessageToolSendActionName(action)) {
    return true;
  }
  if (typeof action !== "string") {
    return false;
  }
  // Polls and reply-type actions deliver the visible source answer too; they
  // qualify only when the runner confirmed the current-source route (or the
  // caller allows explicit routes), enforced by the caller below.
  const normalized = action.trim().toLowerCase();
  return normalized === "reply" || normalized === "thread-reply" || normalized === "poll";
}

/** Read the visible text delivered by a source-reply message action. */
export function readMessageToolSourceReplyText(args: unknown): string | undefined {
  const record = asOptionalRecord(args) ?? {};
  if (!isMessageToolSourceReplyActionName(record.action)) {
    return undefined;
  }
  if (normalizeStatus(record.action) === "poll") {
    return readStringValue(record.pollQuestion) ?? readStringValue(record.poll_question);
  }
  for (const key of ["content", "message", "text", "body"]) {
    const value = readStringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function isBareOkDeliveryStatus(value: unknown): boolean {
  return normalizeStatus(value) === BARE_OK_DELIVERY_STATUS;
}

function isBareSentDeliveryStatus(value: unknown): boolean {
  return normalizeStatus(value) === SENT_DELIVERY_STATUS;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  return asOptionalRecord(safeParseJson(value));
}

function recordHasDeliveredMessageId(record: Record<string, unknown>): boolean {
  const hasDeliveredId = (value: unknown) => {
    const normalized = normalizeStatus(value);
    return Boolean(normalized && !NON_DELIVERY_MESSAGE_IDS.has(normalized));
  };
  const message = asOptionalRecord(record.message) ?? {};
  if (
    hasDeliveredId(record.messageId) ||
    hasDeliveredId(record.pollId) ||
    hasDeliveredId(message.id)
  ) {
    return true;
  }
  const receipt = record.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return false;
  }
  const receiptRecord = receipt as Record<string, unknown>;
  return (
    hasDeliveredId(receiptRecord.primaryPlatformMessageId) ||
    (Array.isArray(receiptRecord.platformMessageIds) &&
      receiptRecord.platformMessageIds.some((value) => hasDeliveredId(value)))
  );
}

function deliveryEnvelopeHasCreatedConversationId(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeHasCreatedConversationId(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (
    hasConversationIdValue(record.topicId) ||
    hasConversationIdValue(record.threadId) ||
    hasConversationIdValue(record.messageThreadId)
  ) {
    return true;
  }
  const thread = record.thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    if (hasConversationIdValue((thread as Record<string, unknown>).id)) {
      return true;
    }
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeHasCreatedConversationId(parsed, depth + 1)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeHasCreatedConversationId(item, depth + 1))
  ) {
    return true;
  }
  return PARTIAL_DELIVERY_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeHasCreatedConversationId(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesOk(value: unknown, depth = 0): boolean {
  if (isBareOkDeliveryStatus(value)) {
    return true;
  }
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesOk(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesOk(parsed, depth + 1)) {
      return true;
    }
    if (isBareOkDeliveryStatus(record.text)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeIndicatesOk(item, depth + 1))
  ) {
    return true;
  }
  return RESULT_ENVELOPE_KEYS.some((key) => deliveryEnvelopeIndicatesOk(record[key], depth + 1));
}

function deliveryEnvelopeIndicatesNonDelivery(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesNonDelivery(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const messageId = normalizeStatus(record.messageId);
  if (
    (messageId && NON_DELIVERY_MESSAGE_IDS.has(messageId)) ||
    normalizeStatus(record.deliveryStatus) === "suppressed" ||
    normalizeStatus(record.status) === "suppressed"
  ) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesNonDelivery(parsed, depth + 1)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeIndicatesNonDelivery(item, depth + 1))
  ) {
    return true;
  }
  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesNonDelivery(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesNoOp(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesNoOp(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const removed = record.removed;
  if (
    removed === null ||
    removed === false ||
    removed === 0 ||
    (Array.isArray(removed) && removed.length === 0) ||
    record.applied === false ||
    record.changed === false ||
    record.created === false ||
    record.deleted === false ||
    record.sent === false ||
    record.updated === false
  ) {
    return true;
  }
  const status = normalizeStatus(record.status);
  if (status === "noop" || status === "no_op" || status === "not_found") {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesNoOp(parsed, depth + 1)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeIndicatesNoOp(item, depth + 1))
  ) {
    return true;
  }
  return RESULT_ENVELOPE_KEYS.some((key) => deliveryEnvelopeIndicatesNoOp(record[key], depth + 1));
}

function broadcastEntryHasSuccessfulBareOkSend(
  record: Record<string, unknown>,
  depth: number,
): boolean {
  return BROADCAST_SEND_ENVELOPE_KEYS.some((key) => {
    const value = record[key];
    return (
      deliveryEnvelopeIndicatesOk(value, depth + 1) &&
      !deliveryEnvelopeIndicatesNonDelivery(value, depth + 1) &&
      !deliveryEnvelopeIndicatesNoOp(value, depth + 1)
    );
  });
}

function deliveryEnvelopeIndicatesSuccessfulBroadcast(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).ok === true &&
        !deliveryEnvelopeIndicatesNonDelivery(item) &&
        !deliveryEnvelopeIndicatesNoOp(item) &&
        (deliveryEnvelopeIndicatesDelivered(item, depth + 1) ||
          broadcastEntryHasSuccessfulBareOkSend(item as Record<string, unknown>, depth + 1)),
    );
  }
  const record = value as Record<string, unknown>;
  if (deliveryEnvelopeIndicatesSuccessfulBroadcast(record.results, depth + 1)) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesSuccessfulBroadcast(parsed, depth + 1)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeIndicatesSuccessfulBroadcast(item, depth + 1))
  ) {
    return true;
  }
  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesSuccessfulBroadcast(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesDryRun(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesDryRun(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (
    record.dryRun === true ||
    normalizeStatus(record.deliveryStatus) === DRY_RUN_DELIVERY_STATUS ||
    normalizeStatus(record.status) === DRY_RUN_DELIVERY_STATUS
  ) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesDryRun(parsed, depth + 1)) {
      return true;
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (deliveryEnvelopeIndicatesDryRun(item, depth + 1)) {
        return true;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") {
          const parsed = parseJsonRecord(text);
          if (parsed && deliveryEnvelopeIndicatesDryRun(parsed, depth + 1)) {
            return true;
          }
        }
      }
    }
  }

  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDryRun(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesDelivered(
  value: unknown,
  depth = 0,
  requireReceipt = false,
): boolean {
  if (!requireReceipt && isBareSentDeliveryStatus(value)) {
    return true;
  }
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      deliveryEnvelopeIndicatesDelivered(item, depth + 1, requireReceipt),
    );
  }

  const record = value as Record<string, unknown>;
  if (
    (!requireReceipt && normalizeStatus(record.deliveryStatus) === SENT_DELIVERY_STATUS) ||
    (!requireReceipt && normalizeStatus(record.status) === SENT_DELIVERY_STATUS) ||
    recordHasDeliveredMessageId(record)
  ) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesDelivered(parsed, depth + 1, requireReceipt)) {
      return true;
    }
    if (!requireReceipt && isBareSentDeliveryStatus(record.text)) {
      return true;
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (deliveryEnvelopeIndicatesDelivered(item, depth + 1, requireReceipt)) {
        return true;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") {
          const parsed = parseJsonRecord(text);
          if (parsed && deliveryEnvelopeIndicatesDelivered(parsed, depth + 1, requireReceipt)) {
            return true;
          }
        }
      }
    }
  }

  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesDelivered(record[key], depth + 1, requireReceipt),
  );
}

/** Return true when a result envelope carries a provider message identifier. */
export function hasMessagingDeliveryReceipt(value: unknown): boolean {
  return deliveryEnvelopeIndicatesDelivered(value, 0, true);
}

function deliveryEnvelopeIndicatesSessionsSendAccepted(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesSessionsSendAccepted(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (
    SESSIONS_SEND_DELIVERY_STATUSES.has(normalizeStatus(record.deliveryStatus) ?? "") ||
    SESSIONS_SEND_DELIVERY_STATUSES.has(normalizeStatus(record.status) ?? "")
  ) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = parseJsonRecord(record.text);
    if (parsed && deliveryEnvelopeIndicatesSessionsSendAccepted(parsed, depth + 1)) {
      return true;
    }
  }
  const content = record.content;
  if (
    Array.isArray(content) &&
    content.some((item) => deliveryEnvelopeIndicatesSessionsSendAccepted(item, depth + 1))
  ) {
    return true;
  }
  return RESULT_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesSessionsSendAccepted(record[key], depth + 1),
  );
}

function deliveryEnvelopeIndicatesPartialDelivery(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => deliveryEnvelopeIndicatesPartialDelivery(item, depth + 1));
  }

  const record = value as Record<string, unknown>;
  if (
    record.sentBeforeError === true ||
    record.visibleReplySent === true ||
    normalizeStatus(record.deliveryStatus) === PARTIAL_FAILED_DELIVERY_STATUS ||
    normalizeStatus(record.status) === PARTIAL_FAILED_DELIVERY_STATUS
  ) {
    return true;
  }
  return PARTIAL_DELIVERY_ENVELOPE_KEYS.some((key) =>
    deliveryEnvelopeIndicatesPartialDelivery(record[key], depth + 1),
  );
}

/** Return true only when a messaging tool result proves a real visible delivery. */
export function isDeliveredMessagingToolResult(params: {
  toolName?: string;
  args?: unknown;
  result?: unknown;
  hookResult?: unknown;
  isError?: boolean;
}): boolean {
  const args = asOptionalRecord(params.args) ?? {};
  const action = normalizeStatus(args.action);
  if (
    args.dryRun === true ||
    deliveryEnvelopeIndicatesDryRun(params.result) ||
    deliveryEnvelopeIndicatesDryRun(params.hookResult)
  ) {
    return false;
  }
  if (
    deliveryEnvelopeIndicatesPartialDelivery(params.result) ||
    deliveryEnvelopeIndicatesPartialDelivery(params.hookResult)
  ) {
    return true;
  }
  if (
    action &&
    isMessageToolConversationCreateActionName(action) &&
    (deliveryEnvelopeHasCreatedConversationId(params.result) ||
      deliveryEnvelopeHasCreatedConversationId(params.hookResult))
  ) {
    return true;
  }
  if (
    action === "broadcast" &&
    (deliveryEnvelopeIndicatesSuccessfulBroadcast(params.result) ||
      deliveryEnvelopeIndicatesSuccessfulBroadcast(params.hookResult))
  ) {
    return true;
  }
  if (params.isError || isToolResultError(params.result) || isToolResultError(params.hookResult)) {
    return false;
  }
  const normalizedToolName = normalizeToolName(params.toolName ?? MESSAGE_TOOL_NAME);
  const mutationHasBareOk =
    isMessagingToolDeliveryAction(normalizedToolName, args) &&
    action !== "broadcast" &&
    (deliveryEnvelopeIndicatesOk(params.result) || deliveryEnvelopeIndicatesOk(params.hookResult));
  if (
    mutationHasBareOk &&
    !deliveryEnvelopeIndicatesNonDelivery(params.result) &&
    !deliveryEnvelopeIndicatesNonDelivery(params.hookResult) &&
    !deliveryEnvelopeIndicatesNoOp(params.result) &&
    !deliveryEnvelopeIndicatesNoOp(params.hookResult)
  ) {
    return true;
  }
  if (
    deliveryEnvelopeIndicatesNonDelivery(params.result) ||
    deliveryEnvelopeIndicatesNonDelivery(params.hookResult) ||
    deliveryEnvelopeIndicatesNoOp(params.result) ||
    deliveryEnvelopeIndicatesNoOp(params.hookResult)
  ) {
    return false;
  }
  if (normalizedToolName === SESSIONS_SEND_TOOL_NAME) {
    return (
      deliveryEnvelopeIndicatesSessionsSendAccepted(params.result) ||
      deliveryEnvelopeIndicatesSessionsSendAccepted(params.hookResult) ||
      deliveryEnvelopeIndicatesDelivered(params.result) ||
      deliveryEnvelopeIndicatesDelivered(params.hookResult)
    );
  }
  return (
    deliveryEnvelopeIndicatesDelivered(params.result) ||
    deliveryEnvelopeIndicatesDelivered(params.hookResult)
  );
}

/**
 * Only delivered message actions on the confirmed current route qualify.
 * Explicit routes require an authoritative current-source marker from the action runner.
 */
export function isDeliveredMessageToolOnlySourceReplyResult(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  toolName: string;
  args?: unknown;
  result?: unknown;
  hookResult?: unknown;
  isError?: boolean;
  allowExplicitSourceRoute?: boolean;
}): boolean {
  const confirmedCurrentSourceRoute =
    resultConfirmsCurrentSourceRoute(params.result) ||
    resultConfirmsCurrentSourceRoute(params.hookResult);
  if (params.sourceReplyDeliveryMode !== "message_tool_only" && !confirmedCurrentSourceRoute) {
    return false;
  }
  if (normalizeToolName(params.toolName) !== MESSAGE_TOOL_NAME) {
    return false;
  }
  const args = asOptionalRecord(params.args) ?? {};
  const sourceRouteReplyAction =
    (params.allowExplicitSourceRoute === true || confirmedCurrentSourceRoute) &&
    isMessageToolSourceReplyActionName(args.action);
  if (!isMessageToolSendActionName(args.action) && !sourceRouteReplyAction) {
    return false;
  }
  const hasConfirmedExplicitSourceRoute =
    params.allowExplicitSourceRoute === true || confirmedCurrentSourceRoute;
  if (hasExplicitMessageRoute(args) && !hasConfirmedExplicitSourceRoute) {
    return false;
  }
  return isDeliveredMessagingToolResult(params);
}
