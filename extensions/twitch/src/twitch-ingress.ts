// Twitch plugin owns raw chat-envelope durable admission and replay draining.
import { HttpStatusCodeError } from "@twurple/api-call";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getTwitchRuntime } from "./runtime.js";
import type { TwitchChatMessage } from "./types.js";
import { normalizeTwitchChannel } from "./utils/twitch.js";

const TWITCH_INGRESS_PAYLOAD_VERSION = 1;
const TWITCH_INGRESS_DRAIN_INTERVAL_MS = 1_000;
const TWITCH_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const TWITCH_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// Twitch IRC does not replay accepted PRIVMSG lines. These tombstones are near-inert;
// the durable queue protects the local accept-to-dispatch crash window instead.
const TWITCH_INGRESS_COMPLETED_MAX_ENTRIES = 1_000;
const TWITCH_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TWITCH_INGRESS_FAILED_MAX_ENTRIES = 1_000;
const TWITCH_INGRESS_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

type TwitchIngressPayload = {
  version: typeof TWITCH_INGRESS_PAYLOAD_VERSION;
  rawEvent: string;
};

type TwitchIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type TwitchIngress = {
  accept: (message: TwitchChatMessage) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

class TwitchIngressPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TwitchIngressPermanentError";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectTwitchIngressEvent(event: unknown): { eventId: string; laneKey: string } {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TwitchIngressPermanentError("Twitch ingress event must be an object.");
  }
  const candidate = event as { id?: unknown; channel?: unknown };
  const eventId = nonEmptyString(candidate.id);
  if (!eventId) {
    throw new TwitchIngressPermanentError("Twitch ingress event is missing its message id.");
  }
  const rawChannel = nonEmptyString(candidate.channel);
  const channel = rawChannel ? normalizeTwitchChannel(rawChannel) : "";
  if (!channel) {
    throw new TwitchIngressPermanentError("Twitch ingress event is missing its channel.");
  }
  return { eventId, laneKey: `channel:${channel}` };
}

function parseClaimedTwitchMessage(
  payload: TwitchIngressPayload,
  claimedId: string,
  claimedLaneKey: string | undefined,
): TwitchChatMessage {
  if (payload.version !== TWITCH_INGRESS_PAYLOAD_VERSION || typeof payload.rawEvent !== "string") {
    throw new TwitchIngressPermanentError("Twitch ingress payload is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new TwitchIngressPermanentError("Twitch ingress event JSON is invalid.", {
      cause: error,
    });
  }
  const facts = inspectTwitchIngressEvent(parsed);
  if (facts.eventId !== claimedId || facts.laneKey !== claimedLaneKey) {
    throw new TwitchIngressPermanentError(
      "Twitch ingress event identity changed after durable admission.",
    );
  }
  const candidate = parsed as Partial<TwitchChatMessage>;
  const username = nonEmptyString(candidate.username);
  const rawChannel = nonEmptyString(candidate.channel);
  if (!username || typeof candidate.message !== "string" || !rawChannel) {
    throw new TwitchIngressPermanentError("Twitch ingress event shape is invalid.");
  }
  return {
    ...candidate,
    id: claimedId,
    username,
    message: candidate.message,
    channel: normalizeTwitchChannel(rawChannel),
  } as TwitchChatMessage;
}

function isTwitchAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (
      current instanceof HttpStatusCodeError &&
      (current.statusCode === 401 || current.statusCode === 403)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function stoppedError(): Error {
  return new Error("Twitch ingress stopped before dispatch.");
}

export function createTwitchIngress(options: {
  accountId: string;
  runtime: { error?: (message: string) => void };
  deliver: (message: TwitchChatMessage, lifecycle: TwitchIngressLifecycle) => Promise<void>;
  queue?: ChannelIngressQueue<TwitchIngressPayload>;
  pollIntervalMs?: number;
}): TwitchIngress {
  const queue =
    options.queue ??
    getTwitchRuntime().state.openChannelIngressQueue<TwitchIngressPayload>({
      accountId: options.accountId,
    });
  const shutdown = new AbortController();
  const activeDeliveries = new Set<Promise<void>>();
  const deferredClaims = new Map<string, Promise<void>>();
  let running = false;
  let stopped = false;
  let drainRequested = false;
  let drainTask: Promise<void> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  let stopTask: Promise<void> | undefined;

  const drain = createChannelIngressDrain<TwitchIngressPayload>({
    queue,
    abortSignal: shutdown.signal,
    adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
    resolveNonRetryableFailure: (error) => {
      if (error instanceof TwitchIngressPermanentError) {
        return { reason: "invalid-event", message: error.message };
      }
      if (isTwitchAuthenticationFailure(error)) {
        return { reason: "authentication-failed", message: formatErrorMessage(error) };
      }
      return null;
    },
    onLog: (message) => options.runtime.error?.(`twitch ingress: ${message}`),
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      if (!running || lifecycle.abortSignal.aborted) {
        return { kind: "failed-retryable", error: stoppedError() };
      }
      const message = parseClaimedTwitchMessage(claimed.payload, claimed.id, claimed.laneKey);
      const bound = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
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
        if (deferredClaims.get(claimed.id) === deferredClaim) {
          deferredClaims.delete(claimed.id);
        }
        resolveDeferredClaim();
      };
      const delivery = options.deliver(message, {
        ...bound,
        onAdopted: async () => {
          handedOff = true;
          try {
            await bound.onAdopted();
          } finally {
            settleDeferredClaim();
          }
        },
        onDeferred: () => {
          handedOff = true;
          if (!deferredClaimSettled) {
            deferredClaims.set(claimed.id, deferredClaim);
          }
          bound.onDeferred();
        },
        onAbandoned: async () => {
          handedOff = true;
          try {
            await bound.onAbandoned();
          } finally {
            settleDeferredClaim();
          }
        },
      });
      activeDeliveries.add(delivery);
      try {
        await delivery;
      } catch (error) {
        if (!running || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error };
        }
        throw error;
      } finally {
        activeDeliveries.delete(delivery);
      }
      if (!handedOff) {
        if (!running || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: stoppedError() };
        }
        // Echoes and access-gated messages are terminal no-dispatch events.
        await bound.onAdopted();
      }
      return deferredClaims.has(claimed.id) ? { kind: "deferred" } : { kind: "completed" };
    },
  });

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < TWITCH_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await queue.prune({
      completedTtlMs: TWITCH_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: TWITCH_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: TWITCH_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: TWITCH_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const requestDrain = (): void => {
    if (!running || stopped || shutdown.signal.aborted) {
      return;
    }
    drainRequested = true;
    if (drainTask) {
      return;
    }
    drainTask = (async () => {
      while (drainRequested) {
        if (!running) {
          break;
        }
        drainRequested = false;
        await pruneIfDue();
        if (!running) {
          break;
        }
        const { started } = await drain.drainOnce({ shouldStop: () => !running });
        if (!running || (!drainRequested && started === 0)) {
          break;
        }
      }
    })()
      .catch((error: unknown) => {
        options.runtime.error?.(`Twitch ingress drain failed: ${formatErrorMessage(error)}`);
      })
      .finally(() => {
        drainTask = undefined;
        if (running && drainRequested) {
          requestDrain();
        }
      });
  };

  const admitOnce = async (message: TwitchChatMessage): Promise<void> => {
    const facts = inspectTwitchIngressEvent(message);
    const rawEvent = JSON.stringify(message);
    const receivedAt = Date.now();
    let lastError: unknown;
    for (const delayMs of TWITCH_INGRESS_APPEND_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await queue.enqueue(
          facts.eventId,
          { version: TWITCH_INGRESS_PAYLOAD_VERSION, rawEvent },
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
    accept: (message) => {
      if (stopped) {
        return Promise.reject(stoppedError());
      }
      // Preserve socket arrival order across append retry backoff.
      const admission = admissionTail.then(() => admitOnce(message));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    start: () => {
      if (running || stopped) {
        return;
      }
      running = true;
      requestDrain();
      drainTimer = setInterval(
        requestDrain,
        options.pollIntervalMs ?? TWITCH_INGRESS_DRAIN_INTERVAL_MS,
      );
      drainTimer.unref?.();
    },
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        running = false;
        if (drainTimer) {
          clearInterval(drainTimer);
          drainTimer = undefined;
        }
        await admissionTail;
        shutdown.abort(stoppedError());
        await drainTask;
        await Promise.allSettled(activeDeliveries);
        await Promise.allSettled(deferredClaims.values());
        await drain.waitForIdle();
        // Stop is idempotent, and drain disposal remains safe if cleanup repeats.
        drain.dispose();
        drain.dispose();
      })();
      return stopTask;
    },
  };
}
