// Line plugin module owns durable webhook admission and core-drain wiring.
import type { webhook } from "@line/bot-sdk";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { danger, type RuntimeEnv, warn } from "openclaw/plugin-sdk/runtime-env";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { getLineRuntime } from "./runtime.js";

const LINE_WEBHOOK_SPOOL_VERSION = 1;
const LINE_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;
const LINE_WEBHOOK_DRAIN_SCAN_LIMIT = 100;
const LINE_WEBHOOK_ACTIVE_DELIVERY_STOP_GRACE_MS = 5_000;
const LINE_WEBHOOK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
const LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES = 4096;

type LineWebhookSpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

type LineWebhookIngressEvent = {
  event: webhook.Event;
  destination: string;
};

type LineWebhookSpoolBody = {
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

function parseStoredEvent(rawEvent: string): webhook.Event {
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch (error) {
    throw new LineWebhookPayloadError("LINE webhook event JSON is invalid.", { cause: error });
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

async function waitForActiveDeliveriesBeforeDispose(
  activeDeliveries: ReadonlySet<Promise<void>>,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(activeDeliveries).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), LINE_WEBHOOK_ACTIVE_DELIVERY_STOP_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createLineWebhookSpool(options: LineWebhookSpoolOptions): LineWebhookSpool {
  const queue =
    options.queue ??
    getLineRuntime().state.openChannelIngressQueue<LineWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const activeDeliveries = new Set<Promise<void>>();
  const deferredClaims = new Map<string, Promise<void>>();
  let acceptsDeferredClaims = true;
  const monitor = createChannelIngressMonitor<
    LineWebhookIngressEvent,
    LineWebhookSpoolBody,
    LineWebhookSpoolPayload
  >({
    queue,
    inspect: ({ event }) => {
      const eventId = eventIdFor(event);
      return { eventId, laneKey: laneKeyFor(event, eventId) };
    },
    payload: {
      version: LINE_WEBHOOK_SPOOL_VERSION,
      serialize: ({ event, destination }) => ({
        rawEvent: JSON.stringify(event),
        destination,
      }),
      deserialize: ({ rawEvent, destination }) => ({
        event: parseStoredEvent(rawEvent),
        destination,
      }),
      encode: ({ version, body }) => ({
        version,
        rawEvent: body.rawEvent,
        destination: body.destination,
      }),
      decode: (payload) => {
        if (typeof payload.rawEvent !== "string" || typeof payload.destination !== "string") {
          throw new LineWebhookPayloadError("LINE webhook spool payload is invalid.");
        }
        return {
          version: payload.version,
          body: { rawEvent: payload.rawEvent, destination: payload.destination },
        };
      },
      createClaimError: (kind) =>
        new LineWebhookPayloadError(
          kind === "invalid-version"
            ? "LINE webhook spool payload is invalid."
            : "LINE webhook event identity changed after durable admission.",
        ),
    },
    deliver: async ({ event, destination }, lifecycle, claim) => {
      // Reply options intentionally omit the drain-only onAdoptionFinalizing callback;
      // the monitor wrapper already tracks that callback as a handoff before invoking us.
      const boundLifecycle = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
      let handedOff = false;
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
        if (deferredClaims.get(claim.id) === deferredClaim) {
          deferredClaims.delete(claim.id);
        }
        resolveDeferredClaim();
      };
      const delivery = options.deliver(event, destination, {
        turnAdoptionLifecycle: {
          ...boundLifecycle,
          onAdopted: async () => {
            handedOff = true;
            try {
              await boundLifecycle.onAdopted();
            } finally {
              settleDeferredClaim();
            }
          },
          onDeferred: () => {
            handedOff = true;
            if (!acceptsDeferredClaims) {
              settleDeferredClaim();
              void Promise.resolve()
                .then(() => boundLifecycle.onAbandoned())
                .catch((error: unknown) => {
                  options.runtime.error?.(
                    danger(`line: failed to abandon a late webhook delivery: ${errorText(error)}`),
                  );
                });
              return;
            }
            if (!deferredClaimSettled) {
              deferredClaims.set(claim.id, deferredClaim);
            }
            boundLifecycle.onDeferred();
          },
          onAbandoned: async () => {
            handedOff = true;
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
      if (stopTask && !handedOff) {
        return {
          kind: "failed-retryable" as const,
          error: new Error("LINE webhook spool stopped before delivery handoff."),
        };
      }
      return undefined;
    },
    pollIntervalMs: LINE_WEBHOOK_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: 0,
      completedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
      completedMaxEntries: LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES,
      failedTtlMs: LINE_WEBHOOK_TOMBSTONE_TTL_MS,
      failedMaxEntries: LINE_WEBHOOK_TOMBSTONE_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    // The monitor carries active deliveries across pumps and applies startLimit before each claim.
    waitForDeliveryIdleBeforeRepump: false,
    waitForDeliveryIdleOnStop: false,
    runPumpTask: runDetachedWebhookWork,
    admissionMode: "durable-after-stop",
    drain: {
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
    },
    createStoppedError: () => new Error("LINE webhook spool is stopped."),
    onError: (error) =>
      options.runtime.error?.(danger(`line: webhook spool drain failed: ${errorText(error)}`)),
  });
  let stopTask: Promise<void> | undefined;

  return {
    accept: async (body) => {
      const events = body.events ?? [];
      if (events.length === 0) {
        return;
      }
      await monitor.admitBatch(
        events.map((event) => ({ event, destination: body.destination ?? "" })),
        { receivedAt: Date.now() },
      );
    },
    start: () => {
      if (!stopTask) {
        monitor.start();
      }
    },
    stop: () => {
      stopTask ??= (async () => {
        const pauseTask = monitor.pause();
        await pauseTask;
        try {
          // LINE keeps a bounded active-delivery grace but waits deferred agent runs without a
          // deadline; that asymmetric ownership cannot be expressed by the generic stop policy.
          // Bound restart even though a delivery may finish after its row is recovered;
          // that duplicate-side-effect window is the accepted at-least-once tradeoff.
          const deliveriesSettled = await waitForActiveDeliveriesBeforeDispose(activeDeliveries);
          if (!deliveriesSettled) {
            options.runtime.log(
              warn(
                `line: timed out after ${LINE_WEBHOOK_ACTIVE_DELIVERY_STOP_GRACE_MS}ms waiting for active webhook deliveries; releasing drain ownership`,
              ),
            );
          }
          // Accepted shutdown tradeoff: deferred claims may wait for the full agent run.
          // A deadline would allow duplicate side effects after replacement recovery;
          // remove this wait only when core can cancel or abandon the run before release.
          while (deferredClaims.size > 0) {
            await Promise.allSettled(deferredClaims.values());
          }
          // Close registration only after the live map drains. Later deferrals
          // are rejected through onAbandoned so disposal cannot orphan a run.
          acceptsDeferredClaims = false;
          if (deliveriesSettled) {
            await monitor.waitForIdle();
          }
        } finally {
          await monitor.stop();
        }
      })();
      return stopTask;
    },
  };
}
