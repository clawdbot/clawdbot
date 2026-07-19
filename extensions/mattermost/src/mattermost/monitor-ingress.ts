// Mattermost plugin module owns raw WebSocket durable ingress mapping and draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
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
const MATTERMOST_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const MATTERMOST_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MATTERMOST_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const MATTERMOST_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MATTERMOST_INGRESS_FAILED_MAX_ENTRIES = 20_000;

export type MattermostIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

/** Fan one merged Mattermost turn's adoption lifecycle across every source claim. */
export function buildMattermostFlushIngressLifecycle(
  entries: ReadonlyArray<{ turnAdoptionLifecycle?: MattermostIngressLifecycle }>,
): {
  lifecycle: MattermostIngressLifecycle | undefined;
  settle: () => Promise<void>;
} {
  const lifecycles = entries
    .map((entry) => entry.turnAdoptionLifecycle)
    .filter((lifecycle) => lifecycle !== undefined);
  const [firstLifecycle] = lifecycles;
  if (!firstLifecycle) {
    return { lifecycle: undefined, settle: async () => {} };
  }
  let handedOff = false;
  const adoptAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAdopted();
    }
  };
  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? firstLifecycle.abortSignal
          : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
      onAdopted: async () => {
        handedOff = true;
        await adoptAll();
      },
      onDeferred: () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          lifecycle.onDeferred();
        }
      },
      onAdoptionFinalizing: () => {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
      },
      onAbandoned: async () => {
        handedOff = true;
        await Promise.all(
          lifecycles.map(async (lifecycle) => {
            await lifecycle.onAbandoned();
          }),
        );
      },
    },
    // Gated/no-dispatch turns are terminal and must not leave source claims deferred.
    settle: async () => {
      if (!handedOff) {
        await adoptAll();
      }
    },
  };
}

type MattermostIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEvent: string;
};

type MattermostIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type MattermostIngressDispatch = (
  post: MattermostPost,
  payload: MattermostEventPayload,
  lifecycle: MattermostIngressLifecycle,
) => Promise<MattermostIngressDispatchResult | void> | MattermostIngressDispatchResult | void;

class MattermostIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "mattermost-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MattermostIngressPermanentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  post: MattermostPost;
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
  if (!post || post.id !== eventId || !claimedChannelId) {
    throw new MattermostIngressPermanentError(
      "invalid-event",
      `Mattermost ingress row ${eventId} has invalid post identity.`,
    );
  }
  return { post, payload };
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
    retention: {
      pruneIntervalMs: MATTERMOST_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: MATTERMOST_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: MATTERMOST_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: MATTERMOST_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: MATTERMOST_INGRESS_FAILED_MAX_ENTRIES,
    },
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
