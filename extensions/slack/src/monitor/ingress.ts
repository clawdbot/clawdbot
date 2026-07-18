// Slack plugin module owns durable Events API admission and replay.
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
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

export type SlackIngressTurnLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

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

function assertSlackIngressPayload(
  payload: SlackIngressPayload,
  eventId: string,
): asserts payload is SlackIngressPayload {
  if (payload.version !== SLACK_INGRESS_PAYLOAD_VERSION) {
    throw new SlackIngressPayloadError(`Slack ingress payload ${eventId} was invalid.`);
  }
  if (payload.kind === "relay") {
    if (!asOptionalRecord(payload.message)) {
      throw new SlackIngressPayloadError(`Slack relay ingress payload ${eventId} was invalid.`);
    }
    return;
  }
  if (!asOptionalRecord(payload.body) || resolveSlackEventId(payload.body) !== eventId) {
    throw new SlackIngressPayloadError(`Slack ingress payload ${eventId} was invalid.`);
  }
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
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let app: App | undefined;
  let relayDispatch: SlackRelayIngressDispatch | undefined;
  let running = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;

  const getQueue = (): ChannelIngressQueue<SlackIngressPayload> => {
    queue ??= getSlackRuntime().state.openChannelIngressQueue<SlackIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<SlackIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveSlackIngressNonRetryableFailure,
      deriveLaneKey: (record) =>
        record.payload.kind === "relay"
          ? resolveSlackIngressLane({ event: record.payload.message }, record.id)
          : resolveSlackIngressLane(record.payload.body, record.id),
      ...(options.onLog ? { onLog: options.onLog } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      dispatchClaimedEvent: async (event, lifecycle) => {
        assertSlackIngressPayload(event.payload, event.id);
        if (lifecycle.abortSignal.aborted) {
          throw lifecycle.abortSignal.reason;
        }
        const bound = bindIngressLifecycleToReplyOptions(lifecycle);
        if (event.payload.kind === "relay") {
          if (!relayDispatch) {
            // Transient by design: a claim recovered before the relay source
            // reattaches must retry, not dead-letter, or restart recovery loses it.
            throw new Error("Slack relay ingress dispatcher is not attached.");
          }
          await relayDispatch(event.payload.message, bound.turnAdoptionLifecycle);
          return;
        }
        if (!app) {
          throw new Error("Slack ingress receiver is not attached to a Bolt app.");
        }
        await app.processEvent({
          body: event.payload.body as ReceiverEvent["body"],
          ack: async () => {},
          ...(event.payload.retryNum === undefined ? {} : { retryNum: event.payload.retryNum }),
          ...(event.payload.retryReason === undefined
            ? {}
            : { retryReason: event.payload.retryReason }),
          customProperties: {
            [SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY]: bound.turnAdoptionLifecycle,
          },
        });
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < SLACK_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: SLACK_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: SLACK_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: SLACK_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: SLACK_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        await activeDrain.waitForIdle();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.onLog?.(`slack ingress drain failed: ${formatErrorMessage(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  const acceptReceiverEvent = async (event: ReceiverEvent): Promise<void> => {
    if (!isSlackEventCallback(event.body)) {
      if (!app) {
        throw new Error("Slack ingress receiver is not attached to a Bolt app.");
      }
      await app.processEvent(event);
      return;
    }
    const eventId = resolveSlackEventId(event.body);
    if (!eventId) {
      throw new SlackIngressPayloadError("Slack Events API envelope missing event_id.");
    }
    const receivedAt = Date.now();
    await getQueue().enqueue(
      eventId,
      {
        version: SLACK_INGRESS_PAYLOAD_VERSION,
        receivedAt,
        kind: "events-api",
        body: event.body as PluginJsonValue,
        ...(event.retryNum === undefined ? {} : { retryNum: event.retryNum }),
        ...(event.retryReason === undefined ? {} : { retryReason: event.retryReason }),
      },
      { receivedAt },
    );
    await event.ack();
    requestDrain();
  };

  const acceptRelayEvent = async (event: SlackRelayIngressEvent): Promise<void> => {
    const receivedAt = Date.now();
    await getQueue().enqueue(
      resolveSlackRelayIngressEventId(event),
      {
        version: SLACK_INGRESS_PAYLOAD_VERSION,
        receivedAt,
        kind: "relay",
        message: event.message as PluginJsonValue,
      },
      { receivedAt },
    );
    requestDrain();
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
    start: () => {
      if (running) {
        return;
      }
      running = true;
      pollTimer = setInterval(
        requestDrain,
        options.pollIntervalMs ?? SLACK_INGRESS_POLL_INTERVAL_MS,
      );
      pollTimer.unref?.();
      requestDrain();
    },
    stop: async () => {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      drain?.dispose();
      await pumping;
      await drain?.waitForIdle();
    },
    waitForIdle: async () => {
      for (;;) {
        const activePump = pumping;
        if (!activePump) {
          break;
        }
        await activePump;
      }
      await drain?.waitForIdle();
    },
  };
}
