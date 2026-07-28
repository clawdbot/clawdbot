// Zalo plugin owns raw webhook durable admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { ZaloApiError, type ZaloUpdate } from "./api.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { getZaloRuntime } from "./runtime.js";

const ZALO_WEBHOOK_SPOOL_VERSION = 1;
const ZALO_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;
const ZALO_WEBHOOK_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
// Durable tombstones dominate the retired 5-minute / 5,000-key replay cache.
const ZALO_WEBHOOK_COMPLETED_TTL_MS = 30 * 24 * 60 * 60_000;
const ZALO_WEBHOOK_COMPLETED_MAX_ENTRIES = 20_000;
const ZALO_WEBHOOK_FAILED_TTL_MS = 30 * 24 * 60 * 60_000;
const ZALO_WEBHOOK_FAILED_MAX_ENTRIES = 5_000;

type ZaloWebhookSpoolPayload = {
  version: 1;
  rawEvent: string;
};

export type ZaloWebhookIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export class ZaloWebhookPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZaloWebhookPayloadError";
  }
}

type ZaloWebhookIngress = {
  accept: (rawEvent: string) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseRawRecord(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new ZaloWebhookPayloadError("Zalo webhook body contains invalid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ZaloWebhookPayloadError("Zalo webhook body must be a JSON object.");
  }
  return parsed;
}

function resolveUpdateRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  // Preserve the accepted direct and legacy { ok, result } envelope shapes.
  if (envelope.ok === true && isRecord(envelope.result)) {
    return envelope.result;
  }
  return envelope;
}

function inspectZaloWebhookEvent(rawEvent: string): {
  eventId: string;
  laneKey: string;
  update: Record<string, unknown>;
} {
  const update = resolveUpdateRecord(parseRawRecord(rawEvent));
  const message = isRecord(update.message) ? update.message : null;
  const eventId = nonEmptyString(message?.message_id);
  if (!eventId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
  }
  const chat = isRecord(message?.chat) ? message.chat : null;
  const chatId = nonEmptyString(chat?.id);
  if (!chatId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
  }
  return { eventId, laneKey: `chat:${chatId}`, update };
}

function parseClaimedUpdate(payload: ZaloWebhookSpoolPayload, claimedId: string): ZaloUpdate {
  if (payload.version !== ZALO_WEBHOOK_SPOOL_VERSION || typeof payload.rawEvent !== "string") {
    throw new ZaloWebhookPayloadError("Zalo webhook spool payload is invalid.");
  }
  const facts = inspectZaloWebhookEvent(payload.rawEvent);
  if (facts.eventId !== claimedId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message id changed after durable admission.");
  }
  const eventName = nonEmptyString(facts.update.event_name);
  if (
    eventName !== "message.text.received" &&
    eventName !== "message.image.received" &&
    eventName !== "message.sticker.received" &&
    eventName !== "message.unsupported.received"
  ) {
    throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
  }
  const message = facts.update.message as Record<string, unknown>;
  const from = isRecord(message.from) ? message.from : null;
  const chat = isRecord(message.chat) ? message.chat : null;
  if (!nonEmptyString(from?.id)) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.from.id.");
  }
  if (chat?.chat_type !== "PRIVATE" && chat?.chat_type !== "GROUP") {
    throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid chat type.");
  }
  if (typeof message.date !== "number" || !Number.isFinite(message.date)) {
    throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid date.");
  }
  if (eventName === "message.text.received" && typeof message.text !== "string") {
    throw new ZaloWebhookPayloadError("Zalo text event is missing message.text.");
  }
  return facts.update as unknown as ZaloUpdate;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isZaloAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errorCode?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    if (
      (current instanceof ZaloApiError &&
        (current.errorCode === 401 || current.errorCode === 403)) ||
      candidate.status === 401 ||
      candidate.status === 403 ||
      candidate.statusCode === 401 ||
      candidate.statusCode === 403
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function createZaloWebhookIngress(options: {
  accountId: string;
  runtime: Pick<ZaloRuntimeEnv, "error" | "log">;
  deliver: (update: ZaloUpdate, lifecycle: ZaloWebhookIngressLifecycle) => Promise<void>;
  queue?: ChannelIngressQueue<ZaloWebhookSpoolPayload>;
}): ZaloWebhookIngress {
  const queue =
    options.queue ??
    getZaloRuntime().state.openChannelIngressQueue<ZaloWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const deferredClaims = new Map<string, Promise<void>>();
  const monitor = createChannelIngressMonitor<string, string, ZaloWebhookSpoolPayload>({
    queue,
    inspect: (rawEvent) => inspectZaloWebhookEvent(rawEvent),
    payload: {
      storage: "raw-event",
      version: ZALO_WEBHOOK_SPOOL_VERSION,
      serialize: (rawEvent) => rawEvent,
      deserialize: (rawEvent) => rawEvent,
      createClaimError: (kind) =>
        new ZaloWebhookPayloadError(
          kind === "invalid-version"
            ? "Zalo webhook spool payload is invalid."
            : "Zalo webhook identity changed after durable admission.",
        ),
    },
    deliver: async (_rawEvent, lifecycle, claim) => {
      const update = parseClaimedUpdate(claim.payload, claim.id);
      const boundLifecycle = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
      let resolveDeferredClaim!: () => void;
      const deferredClaim = new Promise<void>((resolve) => {
        resolveDeferredClaim = resolve;
      });
      let deferredClaimSettled = false;
      const settleDeferredClaim = () => {
        if (deferredClaimSettled) {
          return;
        }
        deferredClaimSettled = true;
        if (deferredClaims.get(claim.id) === deferredClaim) {
          deferredClaims.delete(claim.id);
        }
        resolveDeferredClaim();
      };
      await options.deliver(update, {
        ...boundLifecycle,
        onAdopted: async () => {
          try {
            await boundLifecycle.onAdopted();
          } finally {
            settleDeferredClaim();
          }
        },
        onDeferred: () => {
          if (!deferredClaimSettled) {
            deferredClaims.set(claim.id, deferredClaim);
          }
          boundLifecycle.onDeferred();
        },
        onAbandoned: () => {
          void Promise.resolve(boundLifecycle.onAbandoned()).finally(settleDeferredClaim);
        },
      });
      return deferredClaims.has(claim.id) ? { kind: "deferred" } : { kind: "completed" };
    },
    pollIntervalMs: ZALO_WEBHOOK_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: ZALO_WEBHOOK_PRUNE_INTERVAL_MS,
      completedTtlMs: ZALO_WEBHOOK_COMPLETED_TTL_MS,
      completedMaxEntries: ZALO_WEBHOOK_COMPLETED_MAX_ENTRIES,
      failedTtlMs: ZALO_WEBHOOK_FAILED_TTL_MS,
      failedMaxEntries: ZALO_WEBHOOK_FAILED_MAX_ENTRIES,
    },
    waitForDeliveryIdleBeforeRepump: false,
    runPumpTask: runDetachedWebhookWork,
    drain: {
      adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
      startLimit: ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof ZaloWebhookPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isZaloAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: errorText(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(`zalo ingress: ${message}`),
    },
    createStoppedError: () => new Error("Zalo ingress stopped."),
    onError: (error) => options.runtime.error?.(`zalo ingress drain failed: ${errorText(error)}`),
  });

  return {
    accept: async (rawEvent) => {
      await monitor.admit(rawEvent);
    },
    start: monitor.start,
    stop: async () => {
      await monitor.stop();
      // Deferred adoption can outlive dispatch, so its channel-owned settlement
      // remains outside the generic delivery lifetime.
      await Promise.allSettled(deferredClaims.values());
    },
  };
}

export const zaloWebhookIngressRuntime = { createZaloWebhookIngress };
