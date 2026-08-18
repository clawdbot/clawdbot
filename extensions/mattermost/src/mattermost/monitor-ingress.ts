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

type MattermostIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

export type MattermostIngressPost = MattermostPost & { user_id: string };

type MattermostIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type MattermostIngressDispatch = (
  post: MattermostIngressPost,
  payload: MattermostEventPayload,
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

function inspectMattermostIngressEvent(rawEvent: string): {
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
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createMattermostIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<MattermostIngressPayload>;
  dispatch: MattermostIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): MattermostIngressMonitor {
  const monitor = createChannelIngressMonitor<
    string,
    Omit<MattermostIngressPayload, "version">,
    MattermostIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getMattermostRuntime().state.openChannelIngressQueue<MattermostIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (rawEvent) => inspectMattermostIngressEvent(rawEvent),
    payload: {
      version: MATTERMOST_INGRESS_PAYLOAD_VERSION,
      serialize: (rawEvent, { receivedAt }) => ({ receivedAt, rawEvent }),
      deserialize: (body) => body.rawEvent,
      encode: ({ body }) => ({ version: MATTERMOST_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawEvent: payload.rawEvent },
      }),
      createClaimError: (kind, claim) =>
        new MattermostIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Mattermost ingress row ${claim.id} has an unsupported version.`
            : `Mattermost ingress row ${claim.id} has invalid post identity.`,
        ),
    },
    deliver: async (rawEvent, lifecycle, claim) => {
      const { post, payload } = parseClaimedEvent(rawEvent, claim.id);
      return await options.dispatch(post, payload, lifecycle);
    },
    pollIntervalMs: options.pollIntervalMs ?? MATTERMOST_INGRESS_POLL_INTERVAL_MS,
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
    receive: (rawEvent) => monitor.admit(rawEvent).then(() => undefined),
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
