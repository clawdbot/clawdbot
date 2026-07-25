// Whatsapp plugin module implements durable receive behavior.
import { createHash } from "node:crypto";
import type { WAMessage } from "baileys";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
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
const WHATSAPP_DURABLE_INBOUND_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const WHATSAPP_DURABLE_INBOUND_PAYLOAD_VERSION = 1;

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

export type WhatsAppIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type WhatsAppIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

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

function inspectWhatsAppIngressMessage(
  message: WAMessage,
  options: { allowConcurrentDebounce?: boolean; claimedLaneKey?: string } = {},
): WhatsAppIngressFacts {
  const remoteJid = message.key?.remoteJid?.trim();
  const id = message.key?.id?.trim();
  if (!remoteJid || !id) {
    throw new WhatsAppIngressPermanentError(
      "missing-message-key",
      "WhatsApp ingress message is missing key.remoteJid or key.id",
    );
  }
  const eventId = createWhatsAppDurableInboundMessageId({ remoteJid, id });
  const allowedLaneKeys = new Set([remoteJid, eventId]);
  const claimedLaneKey = options.claimedLaneKey?.trim();
  return {
    eventId,
    laneKey:
      claimedLaneKey && allowedLaneKeys.has(claimedLaneKey)
        ? claimedLaneKey
        : options.allowConcurrentDebounce
          ? eventId
          : remoteJid,
  };
}

export type WhatsAppDurableInboundQueue = ChannelIngressQueue<WhatsAppDurableInboundPayload>;

type WhatsAppDurableInboundRecord = Awaited<
  ReturnType<WhatsAppDurableInboundQueue["listPending"]>
>[number];

function compareWhatsAppIngressOrder(
  left: WhatsAppDurableInboundRecord,
  right: WhatsAppDurableInboundRecord,
): number {
  const receivedAtDiff = left.receivedAt - right.receivedAt;
  if (receivedAtDiff !== 0) {
    return receivedAtDiff;
  }
  const leftOrder = left.payload.receiveOrder;
  const rightOrder = right.payload.receiveOrder;
  if (leftOrder === undefined || rightOrder === undefined) {
    if (leftOrder === undefined && rightOrder !== undefined) {
      return -1;
    }
    if (leftOrder !== undefined && rightOrder === undefined) {
      return 1;
    }
  } else {
    const receiveOrderDiff = leftOrder - rightOrder;
    if (receiveOrderDiff !== 0) {
      return receiveOrderDiff;
    }
  }
  return left.id.localeCompare(right.id);
}

function orderWhatsAppDurableInboundQueue(
  queue: WhatsAppDurableInboundQueue,
): WhatsAppDurableInboundQueue {
  return {
    ...queue,
    // The shared drain requests its complete pending snapshot before building candidateIds.
    // Reorder that same snapshot here; do not widen a caller's requested queue scan.
    listPending: async (options) =>
      (await queue.listPending(options)).toSorted(compareWhatsAppIngressOrder),
    claimNext: async (options) => {
      const candidateIds = options?.candidateIds ? [...options.candidateIds] : undefined;
      if (!candidateIds) {
        return await queue.claimNext(options);
      }
      // The shared queue's same-millisecond fallback is event id. Claim one
      // candidate at a time so persisted transport order remains authoritative.
      for (const candidateId of candidateIds) {
        const claim = await queue.claimNext({
          ...options,
          candidateIds: [candidateId],
        });
        if (claim) {
          return claim;
        }
      }
      return null;
    },
  };
}

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
  allowConcurrentDebounce?: boolean;
}) {
  const facts = inspectWhatsAppIngressMessage(
    params.message,
    params.allowConcurrentDebounce === undefined
      ? {}
      : { allowConcurrentDebounce: params.allowConcurrentDebounce },
  );
  const receivedAt = params.receivedAt ?? Date.now();
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

/** Shared monitor with durable lane claims completed only at reply-lane adoption. */
export function createWhatsAppIngressMonitor(params: {
  queue: WhatsAppDurableInboundQueue;
  dispatch: (
    message: WAMessage,
    payload: WhatsAppDurableInboundPayload,
    lifecycle: WhatsAppIngressLifecycle,
  ) => Promise<WhatsAppIngressDispatchResult> | WhatsAppIngressDispatchResult;
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
  onActivityChange?: (active: boolean) => void;
  pollIntervalMs: number;
  abortSignal?: AbortSignal;
}) {
  return createChannelIngressMonitor<
    WAMessage,
    WhatsAppDurableInboundPayload,
    WhatsAppDurableInboundPayload
  >({
    queue: orderWhatsAppDurableInboundQueue(params.queue),
    inspect: (message, context) =>
      inspectWhatsAppIngressMessage(
        message,
        context.phase === "claim" ? { claimedLaneKey: context.claimedLaneKey } : {},
      ),
    payload: {
      version: WHATSAPP_DURABLE_INBOUND_PAYLOAD_VERSION,
      serialize: (message, { receivedAt }) => ({
        message: serializeWhatsAppDurableInboundMessage(message),
        receivedAt,
      }),
      deserialize: (payload) => deserializeWhatsAppDurableInboundMessage(payload.message),
      encode: ({ body }) => body,
      // This shipped queue shape predates the shared envelope. Treat it as v1
      // without rewriting or rejecting durable rows accepted by the beta.
      decode: (payload) => ({ version: WHATSAPP_DURABLE_INBOUND_PAYLOAD_VERSION, body: payload }),
      createClaimError: (kind) =>
        new WhatsAppIngressPermanentError(
          kind === "invalid-version" ? "invalid-payload" : "event-id-mismatch",
          kind === "invalid-version"
            ? "WhatsApp ingress row has an invalid payload version"
            : "WhatsApp ingress row identity does not match its transport message key",
        ),
    },
    // WhatsApp can retain adoption for its debounce/reply lane. Require an explicit
    // outcome so a retained callback cannot fall through to the monitor's terminal default.
    deliver: (message, lifecycle, claim) => params.dispatch(message, claim.payload, lifecycle),
    pollIntervalMs: params.pollIntervalMs,
    retention: {
      pruneIntervalMs: WHATSAPP_DURABLE_INBOUND_PRUNE_INTERVAL_MS,
      pendingTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      pendingMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      completedTtlMs: WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS,
      completedMaxEntries: WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
      failedTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      failedMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    },
    drain: {
      resolveNonRetryableFailure: resolveWhatsAppIngressNonRetryableFailure,
      deriveLaneKey: (record) => {
        if (record.laneKey) {
          return record.laneKey;
        }
        try {
          return inspectWhatsAppIngressMessage(
            deserializeWhatsAppDurableInboundMessage(record.payload.message),
          ).laneKey;
        } catch {
          return record.id;
        }
      },
      ...(params.onLog ? { onLog: params.onLog } : {}),
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    admissionMode: "while-running",
    createStoppedError: () => new Error("WhatsApp ingress monitor is stopped."),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.onActivityChange ? { onActivityChange: params.onActivityChange } : {}),
  });
}
