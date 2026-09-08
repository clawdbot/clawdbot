import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString, readStringValue } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import {
  pluginBroadcastHasDelivery,
  pluginEnvelopeHas,
  readEmbeddedMessageDeliveryFact,
} from "./embedded-agent-message-delivery.js";
import {
  isMessageToolConversationCreateActionName,
  isMessageToolSendActionName,
  isMessagingToolDeliveryAction,
} from "./embedded-agent-messaging.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { isToolResultError, readToolResultDetails } from "./tool-result-error.js";

const EXPLICIT_MESSAGE_ROUTE_KEYS = ["channel", "target", "to", "channelId", "provider"];
export function resolveMessageToolSourceReplyFinal(args: unknown): boolean {
  return (asOptionalRecord(args) ?? {}).final !== false;
}

function resultConfirmsCurrentSourceRoute(value: unknown): boolean {
  return asOptionalRecord(asOptionalRecord(value)?.details)?.sourceReplyRoute === "current-source";
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

export function hasPluginMessagingDeliveryId(value: unknown): boolean {
  return pluginEnvelopeHas(value, "deliveryId");
}

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
  const normalizedToolName = normalizeToolPolicyName(params.toolName ?? "message");
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
  const deliveryFact =
    readEmbeddedMessageDeliveryFact(readToolResultDetails(params.hookResult)?.messageDelivery) ??
    readEmbeddedMessageDeliveryFact(readToolResultDetails(params.result)?.messageDelivery);
  const confirmedCurrentSourceRoute =
    deliveryFact?.sourceReplyDelivered === true ||
    resultConfirmsCurrentSourceRoute(params.result) ||
    resultConfirmsCurrentSourceRoute(params.hookResult);
  if (params.sourceReplyDeliveryMode !== "message_tool_only" && !confirmedCurrentSourceRoute) {
    return false;
  }
  if (normalizeToolPolicyName(params.toolName) !== "message") {
    return false;
  }
  const args = asOptionalRecord(params.args) ?? {};
  // A recorded `current-source` route is the producer's own delivery fact: it already
  // proved this send reached the run's conversation. Re-deriving eligibility from the
  // action name here silently drops native sends the name list does not enumerate.
  const sourceRouteReplyAction =
    confirmedCurrentSourceRoute ||
    (params.allowExplicitSourceRoute === true && isMessageToolSourceReplyActionName(args.action));
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
  return (
    params.deliveryConfirmed ??
    (deliveryFact
      ? deliveryFact.status === "settled" && (!params.isError || deliveryFact.partialDelivery)
      : isDeliveredMessagingToolResult(params))
  );
}
