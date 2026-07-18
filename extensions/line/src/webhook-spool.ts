// Line plugin module owns durable webhook admission and core-drain wiring.
import type { webhook } from "@line/bot-sdk";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { getLineRuntime } from "./runtime.js";

const LINE_WEBHOOK_SPOOL_VERSION = 1;
const LINE_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;
const LINE_WEBHOOK_DRAIN_SCAN_LIMIT = 100;
const LINE_WEBHOOK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES = 4096;

type LineWebhookSpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

export type LineWebhookTurnAdoptionLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type LineWebhookSpoolOptions = {
  accountId: string;
  runtime: RuntimeEnv;
  deliver: (
    event: webhook.Event,
    destination: string,
    control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
  ) => Promise<void>;
  queue?: ChannelIngressQueue<LineWebhookSpoolPayload>;
};

class LineWebhookPayloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LineWebhookPayloadError";
  }
}

export class LineWebhookTerminalDeliveryError extends Error {
  readonly reason = "delivery-side-effects-committed" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LineWebhookTerminalDeliveryError";
  }
}

type LineWebhookSpool = {
  accept: (body: webhook.CallbackRequest) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Message ids preserve the shipped replay-guard keyspace; other events use LINE's delivery id. */
function eventIdFor(event: unknown): string {
  if (!event || typeof event !== "object") {
    throw new LineWebhookPayloadError("LINE webhook event must be an object.");
  }
  const candidate = event as {
    type?: unknown;
    message?: { id?: unknown };
    webhookEventId?: unknown;
  };
  if (candidate.type === "message") {
    const messageId = nonEmptyString(candidate.message?.id);
    if (messageId) {
      return `message:${messageId}`;
    }
  }
  const webhookEventId = nonEmptyString(candidate.webhookEventId);
  if (webhookEventId) {
    return `event:${webhookEventId}`;
  }
  throw new LineWebhookPayloadError("LINE webhook event is missing a stable delivery id.");
}

function laneKeyFor(event: unknown, eventId: string): string {
  if (!event || typeof event !== "object") {
    return eventId;
  }
  const source = (event as { source?: Record<string, unknown> }).source;
  if (source?.type === "group") {
    const groupId = nonEmptyString(source.groupId);
    if (groupId) {
      return `group:${groupId}`;
    }
  }
  if (source?.type === "room") {
    const roomId = nonEmptyString(source.roomId);
    if (roomId) {
      return `room:${roomId}`;
    }
  }
  if (source?.type === "user") {
    const userId = nonEmptyString(source.userId);
    if (userId) {
      return `user:${userId}`;
    }
  }
  return eventId;
}

function parseClaimedEvent(payload: LineWebhookSpoolPayload, claimedId: string): webhook.Event {
  if (
    payload.version !== LINE_WEBHOOK_SPOOL_VERSION ||
    typeof payload.rawEvent !== "string" ||
    typeof payload.destination !== "string"
  ) {
    throw new LineWebhookPayloadError("LINE webhook spool payload is invalid.");
  }
  let event: unknown;
  try {
    event = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new LineWebhookPayloadError("LINE webhook event JSON is invalid.", { cause: error });
  }
  if (eventIdFor(event) !== claimedId) {
    throw new LineWebhookPayloadError("LINE webhook event id changed after durable admission.");
  }
  return event as webhook.Event;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLineAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  // @line/bot-sdk HTTPFetchError exposes the response code as `status`.
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export function createLineWebhookSpool(options: LineWebhookSpoolOptions): LineWebhookSpool {
  const queue =
    options.queue ??
    getLineRuntime().state.openChannelIngressQueue<LineWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const shutdown = new AbortController();
  // Match the predecessor worker's per-spool cap across repeated drain pumps.
  const activeDeliveries = new Set<Promise<void>>();
  const deferredClaims = new Map<string, Promise<void>>();
  const drain = createChannelIngressDrain<LineWebhookSpoolPayload>({
    queue,
    abortSignal: shutdown.signal,
    adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
    orderBy: "received",
    scanLimit: LINE_WEBHOOK_DRAIN_SCAN_LIMIT,
    startLimit: LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      // LINE previously dead-lettered on attempt eight. The generic 24-hour floor
      // would let one poison event block its user/group lane for a full day.
      deadLetterMinAgeMs: 0,
    },
    resolveNonRetryableFailure: (error) => {
      if (error instanceof LineWebhookPayloadError) {
        return { reason: "invalid-event", message: error.message };
      }
      if (error instanceof LineWebhookTerminalDeliveryError) {
        return { reason: error.reason, message: error.message };
      }
      if (isLineAuthenticationFailure(error)) {
        return { reason: "authentication-failed", message: errorText(error) };
      }
      return null;
    },
    onLog: (message) => options.runtime.error?.(danger(`line: ${message}`)),
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      const event = parseClaimedEvent(claimed.payload, claimed.id);
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
        // Delete only this dispatch's entry; a later retry may reuse the claim id.
        if (deferredClaims.get(claimed.id) === deferredClaim) {
          deferredClaims.delete(claimed.id);
        }
        resolveDeferredClaim();
      };
      const delivery = options.deliver(event, claimed.payload.destination, {
        turnAdoptionLifecycle: {
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
          onAbandoned: async () => {
            try {
              await boundLifecycle.onAbandoned();
            } finally {
              settleDeferredClaim();
            }
          },
        },
      });
      activeDeliveries.add(delivery);
      try {
        await delivery;
      } finally {
        activeDeliveries.delete(delivery);
      }
    },
  });
  let running = false;
  let drainRequested = false;
  let drainTask: Promise<void> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;

  const requestDrain = (): void => {
    if (!running || shutdown.signal.aborted) {
      return;
    }
    drainRequested = true;
    if (drainTask) {
      return;
    }
    drainTask = runDetachedWebhookWork(async () => {
      while (drainRequested && !shutdown.signal.aborted) {
        if (!running) {
          break;
        }
        drainRequested = false;
        await drain.drainOnce({
          // startLimit caps one pump. Keep later timer pumps from exceeding this
          // spool's delivery cap after an early turn adoption frees the core lane.
          shouldStop: () =>
            !running ||
            shutdown.signal.aborted ||
            activeDeliveries.size >= LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
        });
      }
    })
      .catch((error: unknown) => {
        options.runtime.error?.(danger(`line: webhook spool drain failed: ${errorText(error)}`));
      })
      .finally(() => {
        drainTask = undefined;
        if (running && drainRequested && !shutdown.signal.aborted) {
          requestDrain();
        }
      });
  };

  return {
    accept: async (body) => {
      const events = body.events ?? [];
      if (events.length === 0) {
        return;
      }
      await queue.prune({
        completedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
        completedMaxEntries: LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES,
        failedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
        failedMaxEntries: LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES,
      });
      const receivedAt = Date.now();
      for (const event of events) {
        const eventId = eventIdFor(event);
        await queue.enqueue(
          eventId,
          {
            version: LINE_WEBHOOK_SPOOL_VERSION,
            rawEvent: JSON.stringify(event),
            destination: body.destination ?? "",
          },
          { receivedAt, laneKey: laneKeyFor(event, eventId) },
        );
      }
      requestDrain();
    },
    start: () => {
      if (running) {
        return;
      }
      running = true;
      requestDrain();
      drainTimer = setInterval(requestDrain, LINE_WEBHOOK_DRAIN_INTERVAL_MS);
      drainTimer.unref?.();
    },
    stop: async () => {
      if (!running && shutdown.signal.aborted) {
        return;
      }
      running = false;
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = undefined;
      }
      shutdown.abort();
      await drainTask;
      // Keep the claim owner live until every real delivery and core handler exits;
      // disposing earlier lets a replacement drain recover work still producing replies.
      await Promise.allSettled(activeDeliveries);
      // Accepted shutdown tradeoff: deferred claims may wait for the full agent run.
      // A deadline would allow duplicate side effects after replacement recovery;
      // remove this wait only when core can cancel or abandon the run before release.
      await Promise.allSettled(deferredClaims.values());
      await drain.waitForIdle();
      drain.dispose();
    },
  };
}
