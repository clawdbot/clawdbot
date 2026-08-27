import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { resolveMessageReceiptPrimaryId } from "../channels/message/receipt.js";
import type { MessageReceipt } from "../channels/message/types.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { MessagePollResult, MessageSendResult } from "../infra/outbound/message.js";
import { projectPluginMessageDelivery } from "../infra/outbound/plugin-message-delivery.js";
import type { AgentToolResult } from "./runtime/index.js";

type EmbeddedMessageDeliveryFact = {
  status: "settled" | "suppressed" | "dryRun" | "failed";
  primaryPlatformMessageId?: string;
  partialDelivery: boolean;
  createdThreadIds: string[];
};

const NON_DELIVERY_IDS = new Set(["skipped", "suppressed"]);
const STATUSES = new Set(["settled", "suppressed", "dryRun", "failed"]);

function isDeliveryStatus(value: unknown): value is EmbeddedMessageDeliveryFact["status"] {
  return typeof value === "string" && STATUSES.has(value);
}

function deliveryId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && !NON_DELIVERY_IDS.has(id.toLowerCase()) ? id : undefined;
}

function projectReceiptIdentity(delivery?: {
  receipt?: MessageReceipt;
  messageId?: string;
  pollId?: string;
}) {
  const receipt = delivery?.receipt;
  const primaryPlatformMessageId = [
    receipt ? resolveMessageReceiptPrimaryId(receipt) : undefined,
    delivery?.messageId,
    delivery?.pollId,
    ...(receipt?.parts.map((part) => part.platformMessageId) ?? []),
  ]
    .map(deliveryId)
    .find(Boolean);
  const createdThreadIds = [
    receipt?.threadId,
    ...(receipt?.parts.map((part) => part.threadId) ?? []),
  ].flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : []));
  return { primaryPlatformMessageId, createdThreadIds: [...new Set(createdThreadIds)] };
}

function projectSend(result: MessageSendResult): EmbeddedMessageDeliveryFact {
  const delivery = result.result;
  const { primaryPlatformMessageId, createdThreadIds } = projectReceiptIdentity(delivery);
  const partialDelivery =
    result.deliveryStatus === "partial_failed" || result.sentBeforeError === true;
  const nonDeliveryId =
    typeof delivery?.messageId === "string" &&
    NON_DELIVERY_IDS.has(delivery.messageId.trim().toLowerCase());
  const status = result.dryRun
    ? "dryRun"
    : partialDelivery
      ? "settled"
      : result.deliveryStatus === "suppressed" || nonDeliveryId
        ? "suppressed"
        : result.deliveryStatus === "sent" || primaryPlatformMessageId
          ? "settled"
          : "failed";
  return {
    status,
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    partialDelivery,
    createdThreadIds,
  };
}

function projectPoll(result: MessagePollResult): EmbeddedMessageDeliveryFact {
  const { primaryPlatformMessageId, createdThreadIds } = projectReceiptIdentity(result.result);
  return {
    status: result.dryRun ? "dryRun" : primaryPlatformMessageId ? "settled" : "failed",
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    partialDelivery: false,
    createdThreadIds,
  };
}

export function projectEmbeddedMessageDeliveryFact(
  result: MessageActionResult,
): EmbeddedMessageDeliveryFact | undefined {
  if (result.kind === "send") {
    return result.handledBy === "core" && result.sendResult
      ? projectSend(result.sendResult)
      : result.handledBy === "internal-source"
        ? {
            status: result.dryRun ? "dryRun" : "settled",
            partialDelivery: false,
            createdThreadIds: [],
          }
        : undefined;
  }
  if (result.kind === "poll") {
    return result.handledBy === "core" && result.pollResult
      ? projectPoll(result.pollResult)
      : undefined;
  }
  if (result.kind !== "broadcast") {
    return undefined;
  }
  const entries = result.payload.results.map((entry) => ({
    entry,
    // The broadcast producer normalizes plugin tool output into payload; toolResult is only a
    // legacy visible-envelope shape accepted by pluginBroadcastHasDelivery.
    fact: entry.result
      ? projectSend(entry.result)
      : entry.sentBeforeError
        ? { status: "settled" as const, partialDelivery: true, createdThreadIds: [] }
        : entry.ok
          ? projectPluginMessageDelivery(entry.payload)
          : undefined,
  }));
  const facts = entries.flatMap(({ fact }) => (fact ? [fact] : []));
  const settled = facts.find((fact) => fact.status === "settled");
  if (settled || entries.some(({ entry, fact }) => entry.ok && !entry.result && !fact)) {
    return settled;
  }
  return (
    facts.find((fact) => fact.status === "suppressed") ??
    facts.find((fact) => fact.status === "dryRun") ?? {
      status: "failed",
      partialDelivery: false,
      createdThreadIds: [],
    }
  );
}

export function attachEmbeddedMessageDeliveryFact(
  result: AgentToolResult<unknown>,
  fact: EmbeddedMessageDeliveryFact | undefined,
): AgentToolResult<unknown> {
  const details = asOptionalRecord(result.details);
  if (!fact) {
    if (!details || !("messageDelivery" in details)) {
      return result;
    }
    const { messageDelivery: _reserved, ...rest } = details;
    return { ...result, details: rest };
  }
  return { ...result, details: { ...details, messageDelivery: fact } };
}

export function isDeliveredCoreCurrentChannelWidgetResult(params: {
  coreBuiltinToolNames?: ReadonlySet<string>;
  sourceReplyDeliveryMode?: string;
  toolName: string;
  result: unknown;
  isToolError: boolean;
}): boolean {
  if (
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.toolName !== "show_widget" ||
    params.isToolError ||
    params.coreBuiltinToolNames?.has("show_widget") !== true
  ) {
    return false;
  }
  const details = asOptionalRecord(params.result)?.details;
  const presentation = asOptionalRecord(asOptionalRecord(details)?.presentation);
  const receipt = asOptionalRecord(presentation?.receipt);
  if (asOptionalRecord(details)?.kind !== "widget" || presentation?.target !== "current_channel") {
    return false;
  }
  const receiptIds = [
    receipt?.primaryPlatformMessageId,
    ...(Array.isArray(receipt?.platformMessageIds) ? receipt.platformMessageIds : []),
    ...(Array.isArray(receipt?.parts)
      ? receipt.parts.map((part) => asOptionalRecord(part)?.platformMessageId)
      : []),
  ];
  return receiptIds.some((id) => hasNonEmptyString(id));
}

export function readEmbeddedMessageDeliveryFact(
  value: unknown,
): EmbeddedMessageDeliveryFact | undefined {
  const fact = asOptionalRecord(value);
  const createdThreadIds = Array.isArray(fact?.createdThreadIds)
    ? fact.createdThreadIds.filter((id): id is string => typeof id === "string")
    : [];
  if (
    !fact ||
    !isDeliveryStatus(fact.status) ||
    typeof fact.partialDelivery !== "boolean" ||
    !Array.isArray(fact.createdThreadIds) ||
    createdThreadIds.length !== fact.createdThreadIds.length ||
    (fact.primaryPlatformMessageId !== undefined &&
      typeof fact.primaryPlatformMessageId !== "string")
  ) {
    return undefined;
  }
  return {
    status: fact.status,
    ...(fact.primaryPlatformMessageId
      ? { primaryPlatformMessageId: fact.primaryPlatformMessageId }
      : {}),
    partialDelivery: fact.partialDelivery,
    createdThreadIds,
  };
}
