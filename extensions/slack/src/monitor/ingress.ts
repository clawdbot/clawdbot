// Slack plugin module owns durable Events API admission and replay.
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
} from "openclaw/plugin-sdk/error-runtime";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackRuntime } from "../runtime.js";
import { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

const SLACK_INGRESS_PAYLOAD_VERSION = 1;
const SLACK_INGRESS_POLL_INTERVAL_MS = 1_000;
const SLACK_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const SLACK_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SLACK_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const SLACK_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SLACK_INGRESS_FAILED_MAX_ENTRIES = 20_000;
const SLACK_BOLT_AUTHORIZATION_ERROR = "slack_bolt_authorization_error";

const SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY = "openclawIngressLifecycle";

export type SlackIngressTurnLifecycle = Omit<
  ChannelIngressMonitorLifecycle,
  "onAdoptionFinalizing"
>;

type SlackIngressPayload = {
  version: number;
  receivedAt: number;
} & (
  | {
      kind: "events-api";
      body: PluginJsonValue;
      retryNum?: number;
      retryReason?: string;
    }
  // Relay frames carry a bare message event (no Events API envelope), so the
  // durable key is the logical message identity — the retired guard's exact
  // key space — instead of a router delivery id whose redelivery stability
  // is not a documented contract.
  | { kind: "relay"; message: PluginJsonValue }
);

type SlackRelayIngressEvent = {
  deliveryId: string;
  message: { channel: string; ts?: string; team?: string };
};

type SlackIngressRawEvent =
  | {
      kind: "events-api";
      body: PluginJsonValue;
      retryNum?: number;
      retryReason?: string;
      afterDurableAdmission?: () => Promise<void>;
    }
  | {
      kind: "relay";
      deliveryId: string;
      message: PluginJsonValue;
    };

type SlackIngressBody =
  | {
      receivedAt: number;
      kind: "events-api";
      body: PluginJsonValue;
      retryNum?: number;
      retryReason?: string;
    }
  | { receivedAt: number; kind: "relay"; message: PluginJsonValue };

type SlackRelayIngressDispatch = (
  message: PluginJsonValue,
  lifecycle: SlackIngressTurnLifecycle,
) => Promise<void>;

/** Logical message identity: mirrors the retired guard key (team:channel:ts). */
function resolveSlackRelayIngressEventId(event: SlackRelayIngressEvent): string {
  const ts = event.message.ts?.trim();
  if (!event.message.channel?.trim() || !ts) {
    return `relay:${event.deliveryId}`;
  }
  const team = event.message.team?.trim();
  return `message:${team ? `${team}:` : ""}${event.message.channel.trim()}:${ts}`;
}

type SlackDurableIngressOptions = {
  accountId: string;
  queue?: ChannelIngressQueue<SlackIngressPayload>;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
};

type SlackDurableIngress = {
  wrapReceiver: (receiver: Receiver) => Receiver;
  /** Durable-before-ack accept for relay frames; caller acks after this resolves. */
  acceptRelayEvent: (event: SlackRelayIngressEvent) => Promise<void>;
  /** Relay-mode dispatcher; claimed relay events retry until one is attached. */
  attachRelayDispatch: (dispatch: SlackRelayIngressDispatch) => void;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

class SlackIngressPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackIngressPayloadError";
  }
}

function resolveSlackEventId(body: unknown): string | null {
  const eventId = asOptionalRecord(body)?.event_id;
  return typeof eventId === "string" && eventId.trim() ? eventId.trim() : null;
}

function resolveSlackIngressLane(body: unknown, eventId: string): string {
  const envelope = asOptionalRecord(body);
  const event = asOptionalRecord(envelope?.event);
  const item = asOptionalRecord(event?.item);
  const assistantThread = asOptionalRecord(event?.assistant_thread);
  const team = asOptionalRecord(envelope?.team);
  const teamId =
    [envelope?.team_id, team?.id, event?.team]
      .find((value) => typeof value === "string" && value.trim())
      ?.toString()
      .trim() || "workspace";
  const channelId = [event?.channel, event?.channel_id, item?.channel, assistantThread?.channel_id]
    .find((value) => typeof value === "string" && value.trim())
    ?.toString()
    .trim();
  if (channelId) {
    return `team:${teamId}:conversation:${channelId}`;
  }
  const userId = [event?.user, event?.user_id]
    .find((value) => typeof value === "string" && value.trim())
    ?.toString()
    .trim();
  return userId ? `team:${teamId}:user:${userId}` : `event:${eventId}`;
}

function isSlackEventCallback(body: unknown): boolean {
  return asOptionalRecord(body)?.type === "event_callback";
}

function decodeSlackIngressPayload(
  payload: SlackIngressPayload,
  eventId: string,
): { version: unknown; body: SlackIngressBody } {
  if (payload.kind === "relay") {
    if (!asOptionalRecord(payload.message)) {
      throw new SlackIngressPayloadError(`Slack relay ingress payload ${eventId} was invalid.`);
    }
    return { version: payload.version, body: payload };
  }
  if (!asOptionalRecord(payload.body) || resolveSlackEventId(payload.body) !== eventId) {
    throw new SlackIngressPayloadError(`Slack ingress payload ${eventId} was invalid.`);
  }
  return { version: payload.version, body: payload };
}

function inspectSlackIngress(raw: SlackIngressRawEvent): { eventId: string; laneKey: string } {
  if (raw.kind === "relay") {
    const eventId = resolveSlackRelayIngressEventId({
      deliveryId: raw.deliveryId,
      message: raw.message as SlackRelayIngressEvent["message"],
    });
    return {
      eventId,
      laneKey: resolveSlackIngressLane({ event: raw.message }, eventId),
    };
  }
  const eventId = resolveSlackEventId(raw.body);
  if (!eventId) {
    throw new SlackIngressPayloadError("Slack Events API envelope missing event_id.");
  }
  return { eventId, laneKey: resolveSlackIngressLane(raw.body, eventId) };
}

function resolveSlackIngressNonRetryableFailure(error: unknown) {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
    current.original,
  ])) {
    if (candidate instanceof SlackIngressPayloadError || candidate instanceof SyntaxError) {
      return { reason: "invalid-event", message: formatErrorMessage(candidate) };
    }
    if (
      extractErrorCode(candidate) === SLACK_BOLT_AUTHORIZATION_ERROR ||
      isNonRecoverableSlackAuthError(candidate)
    ) {
      return { reason: "slack-auth", message: formatErrorMessage(candidate) };
    }
  }
  return null;
}

export function resolveSlackIngressTurnLifecycle(
  context: unknown,
): SlackIngressTurnLifecycle | null {
  const candidate = asOptionalRecord(context)?.[SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY];
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const lifecycle = candidate as Partial<SlackIngressTurnLifecycle>;
  return typeof lifecycle.onAdopted === "function" && lifecycle.abortSignal instanceof AbortSignal
    ? (lifecycle as SlackIngressTurnLifecycle)
    : null;
}

export function createSlackDurableIngress(
  options: SlackDurableIngressOptions,
): SlackDurableIngress {
  let app: App | undefined;
  let relayDispatch: SlackRelayIngressDispatch | undefined;
  const monitor = createChannelIngressMonitor<
    SlackIngressRawEvent,
    SlackIngressBody,
    SlackIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getSlackRuntime().state.openChannelIngressQueue<SlackIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: inspectSlackIngress,
    payload: {
      version: SLACK_INGRESS_PAYLOAD_VERSION,
      serialize: (raw, { receivedAt }) =>
        raw.kind === "relay"
          ? { kind: "relay", receivedAt, message: raw.message }
          : {
              kind: "events-api",
              receivedAt,
              body: raw.body,
              ...(raw.retryNum === undefined ? {} : { retryNum: raw.retryNum }),
              ...(raw.retryReason === undefined ? {} : { retryReason: raw.retryReason }),
            },
      deserialize: (body, { claim }) =>
        body.kind === "relay"
          ? {
              kind: "relay",
              deliveryId: claim.id.startsWith("relay:") ? claim.id.slice(6) : claim.id,
              message: body.message,
            }
          : {
              kind: "events-api",
              body: body.body,
              ...(body.retryNum === undefined ? {} : { retryNum: body.retryNum }),
              ...(body.retryReason === undefined ? {} : { retryReason: body.retryReason }),
            },
      encode: ({ body }) => ({ version: SLACK_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeSlackIngressPayload(payload, claim.id),
      createClaimError: (_kind, claim) =>
        new SlackIngressPayloadError(`Slack ingress payload ${claim.id} was invalid.`),
    },
    // Slack's HTTP acknowledgement is transport-private and must complete after
    // durable append but before the shared monitor makes the row drainable.
    onDurableAdmission: async (raw) => {
      if (raw.kind === "events-api") {
        await raw.afterDurableAdmission?.();
      }
    },
    deliver: async (raw, lifecycle) => {
      if (raw.kind === "relay") {
        if (!relayDispatch) {
          // Transient by design: a claim recovered before the relay source
          // reattaches must retry, not dead-letter, or restart recovery loses it.
          throw new Error("Slack relay ingress dispatcher is not attached.");
        }
        await relayDispatch(raw.message, lifecycle);
        return;
      }
      if (!app) {
        throw new Error("Slack ingress receiver is not attached to a Bolt app.");
      }
      await app.processEvent({
        body: raw.body as ReceiverEvent["body"],
        ack: async () => {},
        ...(raw.retryNum === undefined ? {} : { retryNum: raw.retryNum }),
        ...(raw.retryReason === undefined ? {} : { retryReason: raw.retryReason }),
        customProperties: {
          [SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY]: lifecycle,
        },
      });
    },
    pollIntervalMs: options.pollIntervalMs ?? SLACK_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: SLACK_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: SLACK_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: SLACK_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: SLACK_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: SLACK_INGRESS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    drain: {
      resolveNonRetryableFailure: resolveSlackIngressNonRetryableFailure,
      // Shipped Slack rows did not store lanes, so replay still derives them from payloads.
      deriveLaneKey: (record) =>
        record.payload.kind === "relay"
          ? resolveSlackIngressLane({ event: record.payload.message }, record.id)
          : resolveSlackIngressLane(record.payload.body, record.id),
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      ...(options.onLog ? { onLog: options.onLog } : {}),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    onError: (error) => options.onLog?.(`slack ingress drain failed: ${formatErrorMessage(error)}`),
  });

  const acceptReceiverEvent = async (event: ReceiverEvent): Promise<void> => {
    if (!isSlackEventCallback(event.body)) {
      if (!app) {
        throw new Error("Slack ingress receiver is not attached to a Bolt app.");
      }
      await app.processEvent(event);
      return;
    }
    await monitor.admit({
      kind: "events-api",
      body: event.body as PluginJsonValue,
      ...(event.retryNum === undefined ? {} : { retryNum: event.retryNum }),
      ...(event.retryReason === undefined ? {} : { retryReason: event.retryReason }),
      afterDurableAdmission: () => event.ack(),
    });
  };

  const acceptRelayEvent = async (event: SlackRelayIngressEvent): Promise<void> => {
    await monitor.admit({
      kind: "relay",
      deliveryId: event.deliveryId,
      message: event.message as PluginJsonValue,
    });
  };

  return {
    wrapReceiver: (receiver) => {
      const client = Reflect.get(receiver as object, "client");
      const wrapped: Receiver & { client?: unknown } = {
        init: (nextApp) => {
          app = nextApp;
          receiver.init({ processEvent: acceptReceiverEvent } as App);
        },
        start: (...args) => receiver.start(...args),
        stop: (...args) => receiver.stop(...args),
        ...(client === undefined ? {} : { client }),
      };
      return wrapped;
    },
    acceptRelayEvent,
    attachRelayDispatch: (dispatch) => {
      relayDispatch = dispatch;
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
