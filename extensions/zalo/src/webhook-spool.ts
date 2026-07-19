// Zalo plugin owns raw webhook durable admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
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
const ZALO_WEBHOOK_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

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
  let running = false;
  let stopped = false;
  let drainRequested = false;
  let drainTask: Promise<void> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  const activeDeliveries = new Set<Promise<void>>();
  const deferredClaims = new Map<string, Promise<void>>();

  const drain = createChannelIngressDrain<ZaloWebhookSpoolPayload>({
    queue,
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
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      if (!running || lifecycle.abortSignal.aborted) {
        return { kind: "failed-retryable", error: new Error("Zalo ingress stopped.") };
      }
      const update = parseClaimedUpdate(claimed.payload, claimed.id);
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
        if (deferredClaims.get(claimed.id) === deferredClaim) {
          deferredClaims.delete(claimed.id);
        }
        resolveDeferredClaim();
      };
      const delivery = options.deliver(update, {
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
            deferredClaims.set(claimed.id, deferredClaim);
          }
          boundLifecycle.onDeferred();
        },
        onAbandoned: () => {
          void Promise.resolve(boundLifecycle.onAbandoned()).finally(settleDeferredClaim);
        },
      });
      activeDeliveries.add(delivery);
      try {
        await delivery;
      } finally {
        activeDeliveries.delete(delivery);
      }
      return deferredClaims.has(claimed.id) ? { kind: "deferred" } : { kind: "completed" };
    },
  });

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < ZALO_WEBHOOK_PRUNE_INTERVAL_MS) {
      return;
    }
    await queue.prune({
      completedTtlMs: ZALO_WEBHOOK_COMPLETED_TTL_MS,
      completedMaxEntries: ZALO_WEBHOOK_COMPLETED_MAX_ENTRIES,
      failedTtlMs: ZALO_WEBHOOK_FAILED_TTL_MS,
      failedMaxEntries: ZALO_WEBHOOK_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const requestDrain = (): void => {
    if (!running || stopped) {
      return;
    }
    drainRequested = true;
    if (drainTask) {
      return;
    }
    drainTask = runDetachedWebhookWork(async () => {
      while (drainRequested) {
        if (!running) {
          break;
        }
        drainRequested = false;
        await pruneIfDue();
        // stop() can run during the async prune; never start a new claim afterwards.
        if (!running) {
          break;
        }
        await drain.drainOnce({
          shouldStop: () =>
            !running || activeDeliveries.size >= ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
        });
      }
    })
      .catch((error: unknown) => {
        options.runtime.error?.(`zalo ingress drain failed: ${errorText(error)}`);
      })
      .finally(() => {
        drainTask = undefined;
        if (running && drainRequested) {
          requestDrain();
        }
      });
  };

  const admitOnce = async (rawEvent: string): Promise<void> => {
    const facts = inspectZaloWebhookEvent(rawEvent);
    const receivedAt = Date.now();
    let lastError: unknown;
    for (const delayMs of ZALO_WEBHOOK_APPEND_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await queue.enqueue(
          facts.eventId,
          { version: ZALO_WEBHOOK_SPOOL_VERSION, rawEvent },
          { receivedAt, laneKey: facts.laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  return {
    accept: (rawEvent) => {
      // Serialize concurrent webhook admissions so append backoff cannot invert lane order.
      const admission = admissionTail.then(() => admitOnce(rawEvent));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    start: () => {
      if (running || stopped) {
        return;
      }
      running = true;
      requestDrain();
      drainTimer = setInterval(requestDrain, ZALO_WEBHOOK_DRAIN_INTERVAL_MS);
      drainTimer.unref?.();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      running = false;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = undefined;
      }
      // Every accepted request must finish its durable append before shutdown returns.
      await admissionTail;
      drain.dispose();
      await drainTask;
      // A pump may have been between prune and drain when the first dispose ran.
      drain.dispose();
      await Promise.allSettled(activeDeliveries);
      await Promise.allSettled(deferredClaims.values());
      await drain.waitForIdle();
    },
  };
}

export const zaloWebhookIngressRuntime = { createZaloWebhookIngress };
