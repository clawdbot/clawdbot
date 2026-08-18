import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
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
const PLUGIN_ENVELOPE_KEYS = ["details", "payload", "result", "results", "toolResult"];

const EMPTY_DELIVERY_FACT: Pick<
  EmbeddedMessageDeliveryFact,
  "partialDelivery" | "createdThreadIds"
> = {
  partialDelivery: false,
  createdThreadIds: [],
};

function isDeliveryStatus(value: unknown): value is EmbeddedMessageDeliveryFact["status"] {
  return typeof value === "string" && STATUSES.has(value);
}

function deliveryId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && !NON_DELIVERY_IDS.has(id.toLowerCase()) ? id : undefined;
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
  const record = asOptionalRecord(value);
  if (!record) {
    return false;
  }
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
  return PLUGIN_ENVELOPE_KEYS.some((key) => visitPluginEnvelope(record[key], predicate, depth + 1));
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
      (id !== undefined && NON_DELIVERY_IDS.has(id)) ||
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
      ids.some((id) => !NON_DELIVERY_IDS.has(id)) ||
      normalizeStatus(record.status) === "sent" ||
      normalizeStatus(record.text) === "sent"
    );
  },
  deliveryId: (record: Record<string, unknown>) =>
    [record.messageId, record.pollId, asOptionalRecord(record.message)?.id]
      .map(normalizeStatus)
      .some((id) => Boolean(id && !NON_DELIVERY_IDS.has(id))),
  ok: (record: Record<string, unknown>) =>
    record.ok === true || normalizeStatus(record.text) === "ok",
} satisfies Record<string, (record: Record<string, unknown>) => boolean>;

export function pluginEnvelopeHas(value: unknown, signal: keyof typeof PLUGIN_SIGNALS): boolean {
  return visitPluginEnvelope(value, PLUGIN_SIGNALS[signal]);
}

function readPluginDeliveryId(value: unknown): string | undefined {
  let found: string | undefined;
  visitPluginEnvelope(value, (record) => {
    found = [record.messageId, record.pollId, asOptionalRecord(record.message)?.id]
      .map(deliveryId)
      .find(Boolean);
    return found !== undefined;
  });
  return found;
}

function projectPluginPayload(value: unknown): EmbeddedMessageDeliveryFact | undefined {
  if (pluginEnvelopeHas(value, "dryRun")) {
    return { status: "dryRun", ...EMPTY_DELIVERY_FACT };
  }
  if (pluginEnvelopeHas(value, "partial")) {
    return { status: "settled", partialDelivery: true, createdThreadIds: [] };
  }
  if (pluginEnvelopeHas(value, "nonDelivery")) {
    return { status: "suppressed", ...EMPTY_DELIVERY_FACT };
  }
  if (pluginEnvelopeHas(value, "noOp")) {
    return { status: "failed", ...EMPTY_DELIVERY_FACT };
  }
  if (!pluginEnvelopeHas(value, "delivery") && !pluginEnvelopeHas(value, "ok")) {
    return undefined;
  }
  const primaryPlatformMessageId = readPluginDeliveryId(value);
  return {
    status: "settled",
    ...(primaryPlatformMessageId ? { primaryPlatformMessageId } : {}),
    ...EMPTY_DELIVERY_FACT,
  };
}

export function pluginBroadcastHasDelivery(value: unknown): boolean {
  return visitPluginEnvelope(
    value,
    (record) =>
      Array.isArray(record.results) &&
      record.results.some((item) => {
        const entry = asOptionalRecord(item);
        if (!entry || entry.ok !== true || pluginEnvelopeHas(entry, "nonDelivery")) {
          return false;
        }
        return [entry.payload, entry.toolResult].some(
          (payload) => projectPluginPayload(payload)?.status === "settled",
        );
      }),
  );
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
  const entries = result.payload.results.map((entry) => ({
    entry,
    // The broadcast producer normalizes plugin tool output into payload; toolResult is only a
    // legacy visible-envelope shape accepted by pluginBroadcastHasDelivery.
    fact: entry.result
      ? projectSend(entry.result)
      : entry.ok
        ? projectPluginPayload(entry.payload)
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
