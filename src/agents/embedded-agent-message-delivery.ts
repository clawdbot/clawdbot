import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { MessagePollResult, MessageSendResult } from "../infra/outbound/message.js";
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

function projectSend(result: MessageSendResult): EmbeddedMessageDeliveryFact {
  const delivery = result.result;
  const receipt = delivery && "receipt" in delivery ? delivery.receipt : undefined;
  const primaryPlatformMessageId = [
    receipt?.primaryPlatformMessageId,
    delivery?.messageId,
    delivery && "pollId" in delivery ? delivery.pollId : undefined,
    ...(receipt?.platformMessageIds ?? []),
    ...(receipt?.parts.map((part) => part.platformMessageId) ?? []),
  ]
    .map(deliveryId)
    .find(Boolean);
  const createdThreadIds = [
    receipt?.threadId,
    ...(receipt?.parts.map((part) => part.threadId) ?? []),
  ].flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : []));
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
    createdThreadIds: [...new Set(createdThreadIds)],
  };
}

function projectPoll(result: MessagePollResult): EmbeddedMessageDeliveryFact {
  const primaryPlatformMessageId =
    deliveryId(result.result?.messageId) ?? deliveryId(result.result?.pollId);
  return {
    status: result.dryRun ? "dryRun" : primaryPlatformMessageId ? "settled" : "failed",
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    partialDelivery: false,
    createdThreadIds: [],
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
  const facts = result.payload.results.flatMap((entry) =>
    entry.result ? [projectSend(entry.result)] : [],
  );
  const settled = facts.find((fact) => fact.status === "settled");
  if (settled || result.payload.results.some((entry) => entry.ok && !entry.result)) {
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
