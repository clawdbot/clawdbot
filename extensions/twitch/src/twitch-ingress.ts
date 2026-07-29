// Twitch plugin owns raw chat-envelope durable admission and replay draining.
import { HttpStatusCodeError } from "@twurple/api-call";
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
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

type TwitchIngressPayload = {
  version: typeof TWITCH_INGRESS_PAYLOAD_VERSION;
  rawEvent: string;
};

type TwitchIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "onAdoptionFinalizing">;

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

function deserializeTwitchIngressEvent(rawEvent: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new TwitchIngressPermanentError("Twitch ingress event JSON is invalid.", {
      cause: error,
    });
  }
  return parsed;
}

function normalizeClaimedTwitchMessage(event: unknown, claimedId: string): TwitchChatMessage {
  const candidate = event as Partial<TwitchChatMessage>;
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
  let stopped = false;
  const deferredClaims = new Map<string, Promise<void>>();
  const monitor = createChannelIngressMonitor<unknown, string, TwitchIngressPayload>({
    queue,
    inspect: (message) => inspectTwitchIngressEvent(message),
    payload: {
      storage: "raw-event",
      version: TWITCH_INGRESS_PAYLOAD_VERSION,
      serialize: (message) => JSON.stringify(message),
      deserialize: (rawEvent) => deserializeTwitchIngressEvent(rawEvent),
      createClaimError: (kind) =>
        new TwitchIngressPermanentError(
          kind === "invalid-version"
            ? "Twitch ingress payload is invalid."
            : "Twitch ingress event identity changed after durable admission.",
        ),
    },
    deliver: async (rawEvent, lifecycle, claim) => {
      const message = normalizeClaimedTwitchMessage(rawEvent, claim.id);
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
        if (deferredClaims.get(claim.id) === deferredClaim) {
          deferredClaims.delete(claim.id);
        }
        resolveDeferredClaim();
      };
      const deliveryAbortSignal = AbortSignal.any([lifecycle.abortSignal, shutdown.signal]);
      try {
        await options.deliver(message, {
          admission: lifecycle.admission,
          abortSignal: deliveryAbortSignal,
          onAdopted: async () => {
            handedOff = true;
            try {
              await lifecycle.onAdopted();
            } finally {
              settleDeferredClaim();
            }
          },
          onDeferred: () => {
            handedOff = true;
            if (!deferredClaimSettled) {
              deferredClaims.set(claim.id, deferredClaim);
            }
            lifecycle.onDeferred();
          },
          onAbandoned: async () => {
            handedOff = true;
            try {
              await lifecycle.onAbandoned();
            } finally {
              settleDeferredClaim();
            }
          },
        });
      } catch (error) {
        if (stopped || deliveryAbortSignal.aborted) {
          return { kind: "failed-retryable", error };
        }
        throw error;
      }
      if (!handedOff && (stopped || deliveryAbortSignal.aborted)) {
        return { kind: "failed-retryable", error: stoppedError() };
      }
      return undefined;
    },
    pollIntervalMs: options.pollIntervalMs ?? TWITCH_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: TWITCH_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: TWITCH_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: TWITCH_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: TWITCH_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: TWITCH_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
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
    },
    abortSignal: shutdown.signal,
    createStoppedError: stoppedError,
    onError: (error) =>
      options.runtime.error?.(`Twitch ingress drain failed: ${formatErrorMessage(error)}`),
  });
  let stopTask: Promise<void> | undefined;

  return {
    accept: (message) => {
      if (stopped) {
        return Promise.reject(stoppedError());
      }
      return monitor.admit(message).then(() => undefined);
    },
    start: () => {
      if (!stopped) {
        monitor.start();
      }
    },
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        shutdown.abort(stoppedError());
        await monitor.pause();
        await monitor.waitForIdle();
        // Twitch waits for reply-lane ownership to settle before aborting the
        // drain; queued channel turns would otherwise be replayed on restart.
        await Promise.allSettled(deferredClaims.values());
        await monitor.stop();
      })();
      return stopTask;
    },
  };
}
