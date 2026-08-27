import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";

export type PluginMessageDeliveryFact = {
  status: "settled" | "suppressed" | "dryRun" | "failed";
  primaryPlatformMessageId?: string;
  partialDelivery: boolean;
  createdThreadIds: string[];
};

const NON_DELIVERY_IDS = new Set(["skipped", "suppressed"]);
const PLUGIN_ENVELOPE_KEYS = ["details", "payload", "result", "results", "toolResult"];
const EMPTY_DELIVERY_FACT: Pick<PluginMessageDeliveryFact, "partialDelivery" | "createdThreadIds"> =
  {
    partialDelivery: false,
    createdThreadIds: [],
  };

function normalizeStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function deliveryId(value: unknown): string | undefined {
  const id = typeof value === "string" ? value.trim() : "";
  return id && !NON_DELIVERY_IDS.has(id.toLowerCase()) ? id : undefined;
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

/** Classifies a plugin result without treating a bare success envelope as delivery proof. */
export function projectPluginMessageDelivery(
  value: unknown,
): PluginMessageDeliveryFact | undefined {
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
          (payload) => projectPluginMessageDelivery(payload)?.status === "settled",
        );
      }),
  );
}
