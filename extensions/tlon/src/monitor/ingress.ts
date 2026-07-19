// Tlon plugin module owns raw Urbit firehose durable ingress mapping and draining.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getTlonRuntime } from "../runtime.js";
import { UrbitAuthError, UrbitHttpError } from "../urbit/errors.js";

const TLON_INGRESS_PAYLOAD_VERSION = 1;
const TLON_INGRESS_POLL_INTERVAL_MS = 1_000;
const TLON_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const TLON_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// Preserve the retired process-local guard's full 2,000-message key window.
const TLON_INGRESS_TOMBSTONE_MAX_ENTRIES = 2_000;

export type TlonIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

type TlonIngressSource = "channels" | "chat";

type TlonIngressPayload = {
  version: 1;
  receivedAt: number;
  source: TlonIngressSource;
  rawEvent: string;
};

type TlonIngressDrain = {
  drainOnce: (options?: { shouldStop?: () => boolean }) => Promise<{ started: number }>;
  waitForIdle: () => Promise<void>;
  dispose: () => void;
};

type TlonIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type TlonIngressDispatch = (
  source: TlonIngressSource,
  event: unknown,
  lifecycle: TlonIngressLifecycle,
) => Promise<TlonIngressDispatchResult | void> | TlonIngressDispatchResult | void;

class TlonIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "tlon-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TlonIngressPermanentError";
  }
}

class TlonIngressShutdownError extends Error {
  constructor() {
    super("Tlon ingress stopped before dispatch adoption.");
    this.name = "TlonIngressShutdownError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectChannelsEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = isRecord(event) ? event : null;
  const nest = nonEmptyString(envelope?.nest);
  const response = isRecord(envelope?.response) ? envelope.response : null;
  const post = isRecord(response?.post) ? response.post : null;
  const rPost = isRecord(post?.["r-post"]) ? post["r-post"] : null;
  const set = isRecord(rPost?.set) ? rPost.set : null;
  const reply = isRecord(rPost?.reply) ? rPost.reply : null;
  const rReply = isRecord(reply?.["r-reply"]) ? reply["r-reply"] : null;
  const replySet = isRecord(rReply?.set) ? rReply.set : null;
  if (!nest || (!isRecord(set?.essay) && !isRecord(replySet?.memo))) {
    return null;
  }
  const eventId = nonEmptyString(isRecord(replySet?.memo) ? reply?.id : post?.id);
  return eventId ? { eventId, laneKey: `group:${nest}` } : null;
}

function inspectChatEvent(event: unknown): { eventId: string; laneKey: string } | null {
  const envelope = isRecord(event) ? event : null;
  const response = isRecord(envelope?.response) ? envelope.response : null;
  const add = isRecord(response?.add) ? response.add : null;
  const essay = isRecord(add?.essay) ? add.essay : null;
  const eventId = nonEmptyString(envelope?.id);
  if (!essay || !eventId) {
    return null;
  }
  const whom = isRecord(envelope?.whom) ? nonEmptyString(envelope.whom.ship) : null;
  const peer = nonEmptyString(envelope?.whom) ?? whom ?? nonEmptyString(essay.author);
  return { eventId, laneKey: peer ? `direct:${peer}` : `event:${eventId}` };
}

function inspectTlonIngressEvent(
  source: TlonIngressSource,
  event: unknown,
): { eventId: string; laneKey: string } | null {
  // Urbit SSE ids belong to a disposable HTTP channel. The message id inside
  // each firehose envelope survives resubscription and preserves the retired guard key.
  return source === "channels" ? inspectChannelsEvent(event) : inspectChatEvent(event);
}

function parseClaimedEvent(payload: TlonIngressPayload, claimedId: string): unknown {
  if (
    payload.version !== TLON_INGRESS_PAYLOAD_VERSION ||
    (payload.source !== "channels" && payload.source !== "chat") ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} has an invalid payload.`,
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  const facts = inspectTlonIngressEvent(payload.source, event);
  if (!facts || facts.eventId !== claimedId) {
    throw new TlonIngressPermanentError(
      "invalid-event",
      `Tlon ingress row ${claimedId} has invalid message identity.`,
    );
  }
  return event;
}

function resolveTlonIngressNonRetryableFailure(error: unknown) {
  if (error instanceof TlonIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (
      candidate instanceof UrbitAuthError ||
      (candidate instanceof UrbitHttpError &&
        (candidate.status === 401 || candidate.status === 403))
    ) {
      return { reason: "tlon-auth", message: formatErrorMessage(candidate) };
    }
  }
  return null;
}

type TlonIngressMonitor = {
  receive: (params: {
    source: TlonIngressSource;
    event: unknown;
  }) => Promise<{ kind: "accepted" } | { kind: "ignored" }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createTlonIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<TlonIngressPayload>;
  dispatch: TlonIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): TlonIngressMonitor {
  let queue = options.queue;
  let drain: TlonIngressDrain | undefined;
  let accepting = true;
  let running = false;
  let stopped = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let stopPromise: Promise<void> | undefined;

  const getQueue = (): ChannelIngressQueue<TlonIngressPayload> => {
    queue ??= getTlonRuntime().state.openChannelIngressQueue<TlonIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): TlonIngressDrain => {
    drain ??= createChannelIngressDrain<TlonIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveTlonIngressNonRetryableFailure,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onLog: (message) => options.runtime.log?.(`tlon ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        if (!running || lifecycle.abortSignal.aborted || options.abortSignal?.aborted) {
          return { kind: "failed-retryable", error: new TlonIngressShutdownError() };
        }
        const event = parseClaimedEvent(record.payload, record.id);
        try {
          const result = await options.dispatch(record.payload.source, event, lifecycle);
          return !running || options.abortSignal?.aborted
            ? { kind: "failed-retryable", error: new TlonIngressShutdownError() }
            : result;
        } catch (error) {
          if (!running || options.abortSignal?.aborted) {
            return { kind: "failed-retryable", error };
          }
          throw error;
        }
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < TLON_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedMaxEntries: TLON_INGRESS_TOMBSTONE_MAX_ENTRIES,
      failedTtlMs: TLON_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: TLON_INGRESS_TOMBSTONE_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() may race the async prune; never create a live drain afterward.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce({ shouldStop: () => !running });
        await activeDrain.waitForIdle();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`tlon ingress drain failed: ${formatErrorMessage(error)}`);
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

  // Stream callbacks are awaited, but serialize direct test/caller admissions too.
  let admissionTail: Promise<void> = Promise.resolve();

  const admitOnce = async (source: TlonIngressSource, event: unknown): Promise<boolean> => {
    const facts = inspectTlonIngressEvent(source, event);
    if (!facts) {
      return false;
    }
    const receivedAt = Date.now();
    await getQueue().enqueue(
      facts.eventId,
      {
        version: TLON_INGRESS_PAYLOAD_VERSION,
        receivedAt,
        source,
        rawEvent: JSON.stringify(event),
      },
      { receivedAt, laneKey: facts.laneKey },
    );
    requestDrain();
    return true;
  };

  return {
    receive: async ({ source, event }) => {
      if (!accepting) {
        throw new TlonIngressShutdownError();
      }
      let accepted = false;
      const admission = admissionTail.then(async () => {
        accepted = await admitOnce(source, event);
      });
      admissionTail = admission.catch(() => undefined);
      await admission;
      return { kind: accepted ? "accepted" : "ignored" };
    },
    start: () => {
      if (running || stopped) {
        return;
      }
      running = true;
      pollTimer = setInterval(
        requestDrain,
        options.pollIntervalMs ?? TLON_INGRESS_POLL_INTERVAL_MS,
      );
      pollTimer.unref?.();
      requestDrain();
    },
    stop: async () => {
      if (stopPromise) {
        await stopPromise;
        return;
      }
      accepting = false;
      running = false;
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      stopPromise = (async () => {
        await admissionTail;
        drain?.dispose();
        await pumping;
        // A pump may have lazily created the drain before observing running=false.
        drain?.dispose();
        await drain?.waitForIdle();
      })();
      await stopPromise;
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
