import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString, readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import {
  isMessageToolConversationCreateActionName,
  isMessageToolSendActionName,
  isMessagingToolDeliveryAction,
} from "./embedded-agent-messaging.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { isToolResultError } from "./tool-result-error.js";

const MESSAGE_TOOL_NAME = "message";
const EXPLICIT_MESSAGE_ROUTE_KEYS = ["channel", "target", "to", "channelId", "provider"];
const NON_DELIVERY_MESSAGE_IDS = new Set(["skipped", "suppressed"]);
const FALLBACK_ENVELOPE_KEYS = ["details", "payload", "result", "results", "toolResult"];

export function resolveMessageToolSourceReplyFinal(args: unknown): boolean {
  return (asOptionalRecord(args) ?? {}).final !== false;
}

function resultConfirmsCurrentSourceRoute(value: unknown): boolean {
  return (
    (asOptionalRecord(asOptionalRecord(value)?.details) ?? {}).sourceReplyRoute === "current-source"
  );
}

function hasExplicitMessageRoute(args: Record<string, unknown>): boolean {
  return (
    EXPLICIT_MESSAGE_ROUTE_KEYS.some((key) => hasNonEmptyString(args[key])) ||
    (Array.isArray(args.targets) && args.targets.some((value) => hasNonEmptyString(value)))
  );
}

function isMessageToolSourceReplyActionName(action: unknown): boolean {
  return (
    isMessageToolSendActionName(action) ||
    ["reply", "thread-reply", "poll"].includes(normalizeStatus(action) ?? "")
  );
}

export function readMessageToolSourceReplyText(args: unknown): string | undefined {
  const record = asOptionalRecord(args) ?? {};
  if (!isMessageToolSourceReplyActionName(record.action)) {
    return undefined;
  }
  if (normalizeStatus(record.action) === "poll") {
    return readStringValue(record.pollQuestion) ?? readStringValue(record.poll_question);
  }
  return ["content", "message", "text", "body"]
    .map((key) => readStringValue(record[key]))
    .find((value) => value !== undefined);
}

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function visitPluginEnvelope(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (!value || typeof value !== "object" || depth > 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => visitPluginEnvelope(item, predicate, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (predicate(record)) {
    return true;
  }
  if (typeof record.text === "string") {
    const parsed = safeParseJsonRecord(record.text);
    if (parsed && visitPluginEnvelope(parsed, predicate, depth + 1)) {
      return true;
    }
  }
  if (
    Array.isArray(record.content) &&
    record.content.some((item) => visitPluginEnvelope(item, predicate, depth + 1))
  ) {
    return true;
  }
  return FALLBACK_ENVELOPE_KEYS.some((key) =>
    visitPluginEnvelope(record[key], predicate, depth + 1),
  );
}

const PLUGIN_SIGNALS = {
  dryRun: (record: Record<string, unknown>) =>
    record.dryRun === true || normalizeStatus(record.status) === "dry_run",
  partial: (record: Record<string, unknown>) =>
    record.sentBeforeError === true ||
    record.visibleReplySent === true ||
    normalizeStatus(record.status) === "partial_failed",
  conversation: (record: Record<string, unknown>) =>
    [
      record.topicId,
      record.threadId,
      record.messageThreadId,
      asOptionalRecord(record.thread)?.id,
    ].some((id) => hasNonEmptyString(id) || (typeof id === "number" && Number.isFinite(id))),
  nonDelivery: (record: Record<string, unknown>) => {
    const id = normalizeStatus(record.messageId);
    return (
      (id !== undefined && NON_DELIVERY_MESSAGE_IDS.has(id)) ||
      normalizeStatus(record.status) === "suppressed"
    );
  },
  noOp: (record: Record<string, unknown>) => {
    const removed = record.removed;
    const status = normalizeStatus(record.status);
    return (
      removed === null ||
      removed === false ||
      removed === 0 ||
      (Array.isArray(removed) && removed.length === 0) ||
      record.applied === false ||
      record.changed === false ||
      record.created === false ||
      record.deleted === false ||
      record.sent === false ||
      record.updated === false ||
      status === "noop" ||
      status === "no_op" ||
      status === "not_found"
    );
  },
  delivery: (record: Record<string, unknown>) => {
    const message = asOptionalRecord(record.message);
    const ids = [record.messageId, record.pollId, message?.id]
      .map(normalizeStatus)
      .filter((id): id is string => Boolean(id));
    return (
      ids.some((id) => !NON_DELIVERY_MESSAGE_IDS.has(id)) ||
      normalizeStatus(record.status) === "sent" ||
      normalizeStatus(record.text) === "sent"
    );
  },
  deliveryId: (record: Record<string, unknown>) =>
    [record.messageId, record.pollId, asOptionalRecord(record.message)?.id]
      .map(normalizeStatus)
      .some((id) => Boolean(id && !NON_DELIVERY_MESSAGE_IDS.has(id))),
  ok: (record: Record<string, unknown>) =>
    record.ok === true || normalizeStatus(record.text) === "ok",
} satisfies Record<string, (record: Record<string, unknown>) => boolean>;

function pluginEnvelopeHas(value: unknown, signal: keyof typeof PLUGIN_SIGNALS): boolean {
  return visitPluginEnvelope(value, PLUGIN_SIGNALS[signal]);
}

export function hasPluginMessagingDeliveryId(value: unknown): boolean {
  return pluginEnvelopeHas(value, "deliveryId");
}

function pluginBroadcastHasDelivery(value: unknown): boolean {
  return visitPluginEnvelope(
    value,
    (record) =>
      Array.isArray(record.results) &&
      record.results.some((item) => {
        const entry = asOptionalRecord(item);
        if (!entry || entry.ok !== true || pluginEnvelopeHas(entry, "nonDelivery")) {
          return false;
        }
        return [entry.payload, entry.toolResult].some((payload) => {
          return (
            !pluginEnvelopeHas(payload, "noOp") &&
            (pluginEnvelopeHas(payload, "delivery") || pluginEnvelopeHas(payload, "ok"))
          );
        });
      }),
  );
}

/** Return true only when a plugin-native messaging result proves visible delivery. */
export function isDeliveredMessagingToolResult(params: {
  toolName?: string;
  args?: unknown;
  result?: unknown;
  hookResult?: unknown;
  isError?: boolean;
}): boolean {
  const args = asOptionalRecord(params.args) ?? {};
  const action = normalizeStatus(args.action);
  const results = [params.result, params.hookResult];
  if (args.dryRun === true || results.some((result) => pluginEnvelopeHas(result, "dryRun"))) {
    return false;
  }
  if (results.some((result) => pluginEnvelopeHas(result, "partial"))) {
    return true;
  }
  if (
    action &&
    isMessageToolConversationCreateActionName(action) &&
    results.some((result) => pluginEnvelopeHas(result, "conversation"))
  ) {
    return true;
  }
  if (action === "broadcast" && results.some(pluginBroadcastHasDelivery)) {
    return true;
  }
  if (params.isError || results.some(isToolResultError)) {
    return false;
  }
  const normalizedToolName = normalizeToolPolicyName(params.toolName ?? MESSAGE_TOOL_NAME);
  const nonDelivery = results.some((result) => pluginEnvelopeHas(result, "nonDelivery"));
  const noOp = results.some((result) => pluginEnvelopeHas(result, "noOp"));
  if (
    !nonDelivery &&
    !noOp &&
    isMessagingToolDeliveryAction(normalizedToolName, args) &&
    action !== "broadcast" &&
    results.some((result) => pluginEnvelopeHas(result, "ok"))
  ) {
    return true;
  }
  return !nonDelivery && !noOp && results.some((result) => pluginEnvelopeHas(result, "delivery"));
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
  deliveryConfirmed?: boolean;
}): boolean {
  const confirmedCurrentSourceRoute =
    resultConfirmsCurrentSourceRoute(params.result) ||
    resultConfirmsCurrentSourceRoute(params.hookResult);
  if (params.sourceReplyDeliveryMode !== "message_tool_only" && !confirmedCurrentSourceRoute) {
    return false;
  }
  if (normalizeToolPolicyName(params.toolName) !== MESSAGE_TOOL_NAME) {
    return false;
  }
  const args = asOptionalRecord(params.args) ?? {};
  const sourceRouteReplyAction =
    (params.allowExplicitSourceRoute === true || confirmedCurrentSourceRoute) &&
    isMessageToolSourceReplyActionName(args.action);
  if (!isMessageToolSendActionName(args.action) && !sourceRouteReplyAction) {
    return false;
  }
  if (
    hasExplicitMessageRoute(args) &&
    params.allowExplicitSourceRoute !== true &&
    !confirmedCurrentSourceRoute
  ) {
    return false;
  }
  return params.deliveryConfirmed ?? isDeliveredMessagingToolResult(params);
}
