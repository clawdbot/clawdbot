// Mattermost plugin module owns raw WebSocket durable ingress mapping and draining.
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getMattermostRuntime } from "../runtime.js";
import type { MattermostPost } from "./client.js";
import {
  parseMattermostEventPayload,
  parseMattermostPost,
  type MattermostEventPayload,
} from "./monitor-websocket.js";

const MATTERMOST_INGRESS_PAYLOAD_VERSION = 1;
const MATTERMOST_INGRESS_POLL_INTERVAL_MS = 1_000;

export type MattermostIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

/** One durable unit of Mattermost inbound work: a socket event or a button click. */
type MattermostIngressEvent =
  | { kind: "posted"; rawEvent: string }
  | { kind: "interaction"; interaction: MattermostIngressInteraction };

/** The whole click, so replay needs no second lookup of a post the click already rewrote. */
export type MattermostIngressInteraction = {
  eventId: string;
  channelId: string;
  userId: string;
  userName: string;
  actionId: string;
  actionName: string;
  postId: string;
  rootId?: string;
};

type MattermostIngressBody =
  | { receivedAt: number; rawEvent: string }
  | { receivedAt: number; interaction: MattermostIngressInteraction };

type MattermostIngressPayload = { version: 1 } & MattermostIngressBody;

export type MattermostIngressPost = MattermostPost & { user_id: string };

type MattermostIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type MattermostIngressDispatch = (
  post: MattermostIngressPost,
  payload: MattermostEventPayload,
  lifecycle: MattermostIngressLifecycle,
) => Promise<MattermostIngressDispatchResult | void> | MattermostIngressDispatchResult | void;

type MattermostIngressInteractionDispatch = (
  interaction: MattermostIngressInteraction,
  lifecycle: MattermostIngressLifecycle,
) => Promise<MattermostIngressDispatchResult | void> | MattermostIngressDispatchResult | void;

const MattermostIngressPermanentError = createChannelIngressError<
  "invalid-event" | "mattermost-auth"
>("MattermostIngressPermanentError", { withReason: true });

function parseRawObject(raw: string, subject: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MattermostIngressPermanentError(
      "invalid-event",
      `${subject} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new MattermostIngressPermanentError("invalid-event", `${subject} must be a JSON object.`);
  }
  return parsed;
}

function parseRawPost(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return parseRawObject(value, "Mattermost posted event post");
  }
  if (isRecord(value)) {
    return value;
  }
  throw new MattermostIngressPermanentError(
    "invalid-event",
    "Mattermost posted event is missing its post object.",
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new MattermostIngressPermanentError(
    "invalid-event",
    `Mattermost posted event is missing ${field}.`,
  );
}

function inspectMattermostPostedEvent(rawEvent: string): {
  eventId: string;
  laneKey: string;
} | null {
  const envelope = parseRawObject(rawEvent, "Mattermost WebSocket event");
  if (envelope.event !== "posted") {
    return null;
  }
  const data = isRecord(envelope.data) ? envelope.data : null;
  const post = parseRawPost(data?.post);
  const eventId = requiredString(post.id, "post.id");
  requiredString(post.user_id, "post.user_id");
  // Mattermost can carry the channel id on the post, the event data, or the
  // broadcast envelope (the monitor dispatch honors all three). Rejecting the
  // envelope-level shapes as permanent would drop valid posts and tear the
  // socket down for a storage failure that never happened.
  const broadcast = isRecord(envelope.broadcast) ? envelope.broadcast : null;
  const channelId =
    typeof post.channel_id === "string" && post.channel_id.trim()
      ? post.channel_id.trim()
      : typeof data?.channel_id === "string" && data.channel_id.trim()
        ? data.channel_id.trim()
        : requiredString(broadcast?.channel_id, "channel_id");
  return { eventId, laneKey: `channel:${channelId}` };
}

function inspectMattermostIngressEvent(event: MattermostIngressEvent): {
  eventId: string;
  laneKey: string;
} | null {
  if (event.kind === "posted") {
    return inspectMattermostPostedEvent(event.rawEvent);
  }
  const { eventId, channelId } = event.interaction;
  // A click carries no field Mattermost guarantees unique per press, so admission
  // mints the id. Sharing the posted lane keeps a click ordered behind the messages
  // already queued for its channel.
  return {
    eventId: requiredString(eventId, "interaction.eventId"),
    laneKey: `channel:${requiredString(channelId, "interaction.channelId")}`,
  };
}

function parseClaimedInteraction(
  interaction: MattermostIngressInteraction | undefined,
  eventId: string,
): MattermostIngressInteraction {
  if (!interaction || interaction.eventId !== eventId || !interaction.channelId?.trim()) {
    throw new MattermostIngressPermanentError(
      "invalid-event",
      `Mattermost ingress row ${eventId} has invalid interaction identity.`,
    );
  }
  return interaction;
}

function parseClaimedEvent(
  rawEvent: string,
  eventId: string,
): {
  post: MattermostIngressPost;
  payload: MattermostEventPayload;
} {
  const payload = parseMattermostEventPayload(rawEvent);
  if (!payload || payload.event !== "posted") {
    throw new MattermostIngressPermanentError(
      "invalid-event",
      `Mattermost ingress row ${eventId} is not a posted event.`,
    );
  }
  const post = parseMattermostPost(payload.data?.post);
  // Channel id may live on the post, the event data, or the broadcast — the
  // durable inspector accepted all three, so the claim-side check must too.
  const claimedChannelId =
    post?.channel_id?.trim() ||
    payload.data?.channel_id?.trim() ||
    payload.broadcast?.channel_id?.trim();
  const senderId = post?.user_id?.trim();
  if (!post || post.id !== eventId || !senderId || !claimedChannelId) {
    throw new MattermostIngressPermanentError(
      "invalid-event",
      `Mattermost ingress row ${eventId} has invalid post identity.`,
    );
  }
  return { post: { ...post, user_id: senderId }, payload };
}

function resolveMattermostIngressNonRetryableFailure(error: unknown) {
  if (error instanceof MattermostIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  const message = formatErrorMessage(error);
  return /Mattermost API (?:401|403)\b/.test(message)
    ? { reason: "mattermost-auth", message }
    : null;
}

type MattermostIngressMonitor = {
  receive: (rawEvent: string) => Promise<void>;
  receiveInteraction: (interaction: MattermostIngressInteraction) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createMattermostIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<MattermostIngressPayload>;
  dispatch: MattermostIngressDispatch;
  dispatchInteraction: MattermostIngressInteractionDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): MattermostIngressMonitor {
  const monitor = createChannelIngressMonitor<
    MattermostIngressEvent,
    MattermostIngressBody,
    MattermostIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getMattermostRuntime().state.openChannelIngressQueue<MattermostIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (event) => inspectMattermostIngressEvent(event),
    payload: {
      // Posted rows keep their exact stored shape, so an upgrade never orphans the
      // events a previous process already queued.
      version: MATTERMOST_INGRESS_PAYLOAD_VERSION,
      serialize: (event, { receivedAt }) =>
        event.kind === "posted"
          ? { receivedAt, rawEvent: event.rawEvent }
          : { receivedAt, interaction: event.interaction },
      // Stored bytes become a typed event here, so a row naming neither shape is
      // rejected now. Letting it through would surface later as a plain TypeError,
      // which the drain reads as retryable — one unreadable row would then hold up
      // every post queued behind it in the same lane.
      deserialize: (body) => {
        if ("rawEvent" in body) {
          return { kind: "posted", rawEvent: body.rawEvent };
        }
        if (!("interaction" in body) || !isRecord(body.interaction)) {
          throw new MattermostIngressPermanentError(
            "invalid-event",
            "Mattermost ingress row names neither a posted event nor an interaction.",
          );
        }
        return { kind: "interaction", interaction: body.interaction };
      },
      encode: ({ body }) => ({ version: MATTERMOST_INGRESS_PAYLOAD_VERSION, ...body }),

      decode: (payload) => ({
        version: payload.version,
        body:
          "rawEvent" in payload
            ? { receivedAt: payload.receivedAt, rawEvent: payload.rawEvent }
            : { receivedAt: payload.receivedAt, interaction: payload.interaction },
      }),
      createClaimError: (kind, claim) =>
        new MattermostIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Mattermost ingress row ${claim.id} has an unsupported version.`
            : `Mattermost ingress row ${claim.id} has invalid post identity.`,
        ),
    },
    deliver: async (event, lifecycle, claim) => {
      if (event.kind === "interaction") {
        const interaction = parseClaimedInteraction(event.interaction, claim.id);
        return await options.dispatchInteraction(interaction, lifecycle);
      }
      const { post, payload } = parseClaimedEvent(event.rawEvent, claim.id);
      return await options.dispatch(post, payload, lifecycle);
    },
    pollIntervalMs: options.pollIntervalMs ?? MATTERMOST_INGRESS_POLL_INTERVAL_MS,
    // The interaction route outlives the socket during shutdown, so a click already
    // being answered must still be recorded for the next process to replay.
    admissionMode: "durable-after-stop",
    // Preserve Mattermost's existing one-drain-at-a-time delivery cycle.
    waitForDeliveryIdleBeforeRepump: true,
    retention: "standard",
    drain: {
      resolveNonRetryableFailure: resolveMattermostIngressNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.log?.(`mattermost ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Mattermost ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(`mattermost ingress drain failed: ${formatErrorMessage(error)}`),
  });
  monitor.start();

  return {
    // A click has already been validated and is about to be answered; a failed
    // append must reach the caller so the HTTP response reports the refusal
    // instead of telling Mattermost the click was taken.
    receiveInteraction: async (interaction) => {
      await monitor.admit({ kind: "interaction", interaction });
    },
    receive: async (rawEvent) => {
      try {
        await monitor.admit({ kind: "posted", rawEvent });
      } catch (error) {
        // Permanent shape errors cannot recover through a reconnect; record the drop and keep
        // reading. Storage failures still escape so the WebSocket exposes the outage.
        if (
          !(error instanceof MattermostIngressPermanentError) ||
          error.reason !== "invalid-event"
        ) {
          throw error;
        }
        options.runtime.error?.(`mattermost ingress rejected invalid event: ${error.message}`);
      }
    },
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
