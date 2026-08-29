// Line plugin module owns durable webhook admission and core-drain wiring.
import type { webhook } from "@line/bot-sdk";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressMonitorLifecycle,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, type RuntimeEnv, warn } from "openclaw/plugin-sdk/runtime-env";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { createLineImageSetIngressBuffer } from "./inbound-image-set.js";
import { getLineRuntime } from "./runtime.js";
import {
  eventIdFor,
  laneKeyFor,
  LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON,
  LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE,
  LINE_WEBHOOK_SPOOL_VERSION,
  LineWebhookPayloadError,
  type LineWebhookSpoolPayload,
} from "./webhook-spool-contract.js";

const LINE_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const LINE_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;
const LINE_WEBHOOK_DRAIN_SCAN_LIMIT = 100;
const LINE_WEBHOOK_ACTIVE_DELIVERY_STOP_GRACE_MS = 5_000;

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
    events: readonly webhook.Event[],
    destination: string,
    control: { turnAdoptionLifecycle: LineWebhookTurnAdoptionLifecycle },
  ) => Promise<void>;
  queue?: ChannelIngressQueue<LineWebhookSpoolPayload>;
};

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

function parseStoredEvent(rawEvent: string): webhook.Event {
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch (error) {
    throw new LineWebhookPayloadError("LINE webhook event JSON is invalid.", { cause: error });
  }
  return event as webhook.Event;
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

/** The imageSet a LINE inbound event belongs to, when it reported one. */
function resolveLineInboundImageSet(
  event: webhook.Event,
): { setId: string; messageId: string; index?: number; total?: number } | undefined {
  if (event.type !== "message" || event.message.type !== "image") {
    return undefined;
  }
  const imageSet = event.message.imageSet;
  return imageSet?.id
    ? {
        setId: imageSet.id,
        messageId: event.message.id,
        ...(imageSet.index === undefined ? {} : { index: imageSet.index }),
        ...(imageSet.total === undefined ? {} : { total: imageSet.total }),
      }
    : undefined;
}

export function createLineWebhookSpool(options: LineWebhookSpoolOptions): LineWebhookSpool {
  // Parts of one multi-image send arrive as separate claims; they are grouped
  // here so the whole set becomes one delivery with one fanned-in ownership.
  const imageSets = createLineImageSetIngressBuffer<
    webhook.Event,
    ChannelIngressMonitorLifecycle
  >();
  const queue =
    options.queue ??
    getLineRuntime().state.openChannelIngressQueue<LineWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const activeDeliveries = new Set<Promise<void>>();
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
          throw new LineWebhookPayloadError(LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE);
        }
        return {
          version: payload.version,
          body: { rawEvent: payload.rawEvent, destination: payload.destination },
        };
      },
      createClaimError: (kind) =>
        new LineWebhookPayloadError(
          kind === "invalid-version"
            ? LINE_WEBHOOK_SPOOL_INVALID_PAYLOAD_MESSAGE
            : "LINE webhook event identity changed after durable admission.",
        ),
    },
    deliver: async ({ event, destination }, lifecycle) => {
      const laneKey = laneKeyFor(event, eventIdFor(event));
      const imageSet = resolveLineInboundImageSet(event);
      let turnEvents: readonly webhook.Event[] = [event];
      let turnLifecycles: readonly (typeof lifecycle)[] = [lifecycle];
      if (imageSet) {
        // Hold this claim while the rest of the set arrives. Deferring frees the
        // lane, which is the only way the later parts can be claimed at all.
        lifecycle.onDeferred();
        const set = await imageSets.admit({
          laneKey,
          setId: imageSet.setId,
          messageId: imageSet.messageId,
          event,
          lifecycle,
          ...(imageSet.index === undefined ? {} : { index: imageSet.index }),
          ...(imageSet.total === undefined ? {} : { total: imageSet.total }),
        });
        if (!set) {
          // Another part holds this set and delivers every claim behind it.
          return undefined;
        }
        turnEvents = set.events;
        turnLifecycles = set.lifecycles;
      } else {
        // The lane was released so a set could form; keep this behind it so a
        // message sent after the images is not delivered before them.
        await imageSets.awaitLane(laneKey);
      }
      // One ownership lifecycle spanning every durable claim this turn consumed.
      const fannedIn = fanInChannelIngressLifecycles(turnLifecycles);
      // Reply options intentionally omit the drain-only onAdoptionFinalizing callback;
      // the monitor wrapper already tracks that callback as a handoff before invoking us.
      const boundLifecycle = bindIngressLifecycleToReplyOptions(
        fannedIn.lifecycle ?? lifecycle,
      ).turnAdoptionLifecycle;
      let handedOff = false;
      const delivery = options.deliver(turnEvents, destination, {
        turnAdoptionLifecycle: {
          ...boundLifecycle,
          onAdopted: async () => {
            handedOff = true;
            await boundLifecycle.onAdopted();
          },
          onDeferred: () => {
            handedOff = true;
            if (!acceptsDeferredClaims) {
              void Promise.resolve()
                .then(() => boundLifecycle.onAbandoned())
                .catch((error: unknown) => {
                  options.runtime.error?.(
                    danger(
                      `line: failed to abandon a late webhook delivery: ${formatErrorMessage(error)}`,
                    ),
                  );
                });
              return;
            }
            boundLifecycle.onDeferred();
          },
          onAbandoned: async () => {
            handedOff = true;
            await boundLifecycle.onAbandoned();
          },
        },
      });
      activeDeliveries.add(delivery);
      try {
        await delivery;
      } finally {
        activeDeliveries.delete(delivery);
      }
      if (!handedOff && !stopTask) {
        // A gated or deliberately skipped turn still consumed every source claim.
        await fannedIn.settle();
        handedOff = true;
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
      completedMaxEntries: 4096,
      failedMaxEntries: 4096,
    },
    appendRetryDelaysMs: [0],
    // The monitor carries active deliveries across pumps and applies startLimit before each claim.
    waitForDeliveryIdleBeforeRepump: false,
    waitForDeliveryIdleOnStop: false,
    deferredClaims: "manual",
    runPumpTask: runDetachedWebhookWork,
    admissionMode: "durable-after-stop",
    drain: {
      adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
      // A deferred claim keeps its durable retry guarantee but stops owning the
      // lane. LINE lanes are per sender/group/room, so the parts of one
      // multi-image send share one; holding it would block every later part
      // behind the first, and the set they are meant to join could never form.
      deferredLaneOccupancy: "release",
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
          return { reason: LINE_WEBHOOK_SPOOL_INVALID_EVENT_REASON, message: error.message };
        }
        if (error instanceof LineWebhookTerminalDeliveryError) {
          return { reason: error.reason, message: error.message };
        }
        if (isLineAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(danger(`line: ${message}`)),
    },
    createStoppedError: () => new Error("LINE webhook spool is stopped."),
    onError: (error) =>
      options.runtime.error?.(
        danger(`line: webhook spool drain failed: ${formatErrorMessage(error)}`),
      ),
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
          await monitor.waitForDeferredClaims();
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
