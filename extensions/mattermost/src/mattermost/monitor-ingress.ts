// Mattermost plugin module owns raw WebSocket durable ingress mapping and draining.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
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

type MattermostIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

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
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = true;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;

  const getQueue = (): ChannelIngressQueue<MattermostIngressPayload> => {
    queue ??= getMattermostRuntime().state.openChannelIngressQueue<MattermostIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<MattermostIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveMattermostIngressNonRetryableFailure,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onLog: (message) => options.runtime.log?.(`mattermost ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        if (record.payload.version !== MATTERMOST_INGRESS_PAYLOAD_VERSION) {
          throw new MattermostIngressPermanentError(
            "invalid-event",
            `Mattermost ingress row ${record.id} has an unsupported version.`,
          );
        }
        const { post, payload } = parseClaimedEvent(record.payload.rawEvent, record.id);
        return await options.dispatch(post, payload, lifecycle);
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < MATTERMOST_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: MATTERMOST_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: MATTERMOST_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: MATTERMOST_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: MATTERMOST_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() may have run during the async prune; creating the lazy drain
        // now would leave an undisposed instance dispatching after stop.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        await activeDrain.waitForIdle();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`mattermost ingress drain failed: ${formatErrorMessage(error)}`);
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

  const timer = setInterval(
    requestDrain,
    options.pollIntervalMs ?? MATTERMOST_INGRESS_POLL_INTERVAL_MS,
  );
  timer.unref?.();
  requestDrain();

  // Serialize admissions: WS message callbacks run concurrently, and a post
  // stuck in append-retry backoff must delay its successors or same-channel
  // arrival order inverts in the queue (order over latency).
  let admissionTail: Promise<void> = Promise.resolve();

  const admitOnce = async (rawEvent: string): Promise<void> => {
    const facts = inspectMattermostIngressEvent(rawEvent);
    if (!facts) {
      return;
    }
    const receivedAt = Date.now();
    // Websockets have no nack: a dropped append is a lost post (reconnect
    // never replays). Retry transient failures before letting the error
    // escalate to the socket teardown in monitor-websocket.
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          facts.eventId,
          {
            version: MATTERMOST_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            rawEvent,
          },
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
    receive: (rawEvent) => {
      const admission = admissionTail.then(() => admitOnce(rawEvent));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      // A caller returning from stop() must know every accepted envelope is
      // durably committed; an in-flight admission racing process exit would
      // otherwise lose the post.
      await admissionTail;
      drain?.dispose();
      await pumping;
      // The pump may have lazily created the drain after the first dispose.
      drain?.dispose();
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
