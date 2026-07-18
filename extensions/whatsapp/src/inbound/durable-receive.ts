// Whatsapp plugin module implements durable receive behavior.
import { createHash } from "node:crypto";
import type { WAMessage } from "baileys";
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { getWhatsAppRuntime } from "../runtime.js";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
  WhatsAppIngressPermanentError,
  type SerializedWhatsAppDurableInboundMessage,
} from "./durable-payload.js";

const WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 450;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 5000;
const WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WhatsAppReadReceiptTarget = {
  remoteJid: string;
  id: string;
  participant?: string;
};

export type WhatsAppDurableInboundPayload = {
  message: SerializedWhatsAppDurableInboundMessage;
  upsertType?: string;
  skipStaleAppend?: boolean;
  skipRecentOutboundEcho?: boolean;
  receivedAt: number;
  receiveOrder?: number;
};

export type WhatsAppIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

type WhatsAppIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type WhatsAppIngressFacts = {
  eventId: string;
  laneKey: string;
};

function hashNamespacePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createWhatsAppDurableInboundMessageId(params: {
  remoteJid: string;
  id: string;
}): string {
  return createHash("sha256").update(`${params.remoteJid}\n${params.id}`).digest("hex");
}

function inspectWhatsAppIngressMessage(message: WAMessage): WhatsAppIngressFacts {
  const remoteJid = message.key?.remoteJid?.trim();
  const id = message.key?.id?.trim();
  if (!remoteJid || !id) {
    throw new WhatsAppIngressPermanentError(
      "missing-message-key",
      "WhatsApp ingress message is missing key.remoteJid or key.id",
    );
  }
  return {
    eventId: createWhatsAppDurableInboundMessageId({ remoteJid, id }),
    laneKey: remoteJid,
  };
}

export type WhatsAppDurableInboundQueue = ChannelIngressQueue<WhatsAppDurableInboundPayload>;

/** Account-scoped queue shared with the pre-drain WhatsApp receive journal. */
export function createWhatsAppDurableInboundQueue(accountId: string): WhatsAppDurableInboundQueue {
  return getWhatsAppRuntime().state.openChannelIngressQueue<WhatsAppDurableInboundPayload>({
    accountId: hashNamespacePart(accountId),
    stateDir: getWhatsAppRuntime().state.resolveStateDir(),
  });
}

/** Raw receive chokepoint: append first, then let the drain normalize and dispatch. */
export async function enqueueWhatsAppDurableInbound(params: {
  queue: WhatsAppDurableInboundQueue;
  message: WAMessage;
  upsertType?: string;
  skipStaleAppend?: boolean;
  skipRecentOutboundEcho?: boolean;
  receivedAt?: number;
  receiveOrder?: number;
}) {
  const facts = inspectWhatsAppIngressMessage(params.message);
  const receivedAt = params.receivedAt ?? Date.now();
  await params.queue.prune({
    pendingTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
    completedTtlMs: WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS,
    failedTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
    pendingMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    completedMaxEntries: WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
    failedMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
  });
  return await params.queue.enqueue(
    facts.eventId,
    {
      message: serializeWhatsAppDurableInboundMessage(params.message),
      upsertType: params.upsertType,
      ...(params.skipStaleAppend === undefined ? {} : { skipStaleAppend: params.skipStaleAppend }),
      ...(params.skipRecentOutboundEcho === undefined
        ? {}
        : { skipRecentOutboundEcho: params.skipRecentOutboundEcho }),
      receivedAt,
      ...(params.receiveOrder === undefined ? {} : { receiveOrder: params.receiveOrder }),
    },
    { receivedAt, laneKey: facts.laneKey },
  );
}

function resolveWhatsAppIngressNonRetryableFailure(error: unknown) {
  return error instanceof WhatsAppIngressPermanentError
    ? { reason: error.reason, message: error.message }
    : null;
}

/** Core drain with per-conversation lanes and completion at reply-lane adoption. */
export function createWhatsAppIngressDrain(params: {
  queue: WhatsAppDurableInboundQueue;
  dispatch: (
    message: WAMessage,
    payload: WhatsAppDurableInboundPayload,
    lifecycle: WhatsAppIngressLifecycle,
  ) => Promise<WhatsAppIngressDispatchResult | void> | WhatsAppIngressDispatchResult | void;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
}): ChannelIngressDrain {
  return createChannelIngressDrain<WhatsAppDurableInboundPayload>({
    queue: params.queue,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
    resolveNonRetryableFailure: resolveWhatsAppIngressNonRetryableFailure,
    deriveLaneKey: (record) => {
      try {
        return inspectWhatsAppIngressMessage(
          deserializeWhatsAppDurableInboundMessage(record.payload.message),
        ).laneKey;
      } catch {
        return record.id;
      }
    },
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    // No supersede: every WhatsApp transport event remains independently deliverable.
    dispatchClaimedEvent: async (record, lifecycle) => {
      const message = deserializeWhatsAppDurableInboundMessage(record.payload.message);
      const facts = inspectWhatsAppIngressMessage(message);
      if (facts.eventId !== record.id) {
        throw new WhatsAppIngressPermanentError(
          "event-id-mismatch",
          "WhatsApp ingress row id does not match its transport message key",
        );
      }
      return await params.dispatch(message, record.payload, lifecycle);
    },
  });
}
