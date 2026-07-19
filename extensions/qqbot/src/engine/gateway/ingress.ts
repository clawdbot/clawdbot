// QQBot plugin module owns raw gateway-envelope durable ingress and replay.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { dispatchEvent } from "./event-dispatcher.js";
import {
  inspectQQBotIngressEnvelope,
  parseQQBotClaimedEnvelope,
  QQBotIngressPayloadError,
} from "./ingress-envelope.js";
import { isQQBotAuthenticationFailure } from "./ingress-errors.js";
import type { QueuedMessage } from "./message-queue.js";
import type { EngineLogger, GatewayPluginRuntime, QQBotIngressLifecycle } from "./types.js";

const QQBOT_INGRESS_PAYLOAD_VERSION = 1;
const QQBOT_INGRESS_POLL_INTERVAL_MS = 1_000;
const QQBOT_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
export const QQBOT_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const QQBOT_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const QQBOT_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const QQBOT_INGRESS_FAILED_MAX_ENTRIES = 20_000;

type QQBotIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEnvelope: string;
};

export type QQBotIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type QQBotIngressDispatch = (
  message: QueuedMessage,
  lifecycle: QQBotIngressLifecycle,
  eventId: string,
) => Promise<QQBotIngressDispatchResult | void> | QQBotIngressDispatchResult | void;

export class QQBotIngressAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QQBotIngressAdmissionError";
  }
}

export type QQBotIngressMonitor = {
  receive: (rawEnvelope: string) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createQQBotIngressMonitor(options: {
  accountId: string;
  runtime?: Pick<GatewayPluginRuntime, "state">;
  queue?: ChannelIngressQueue<QQBotIngressPayload>;
  dispatch: QQBotIngressDispatch;
  log?: EngineLogger;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): QQBotIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = true;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;

  const getQueue = (): ChannelIngressQueue<QQBotIngressPayload> => {
    if (!queue) {
      if (!options.runtime) {
        throw new Error("QQBot ingress runtime is unavailable.");
      }
      queue = options.runtime.state.openChannelIngressQueue<QQBotIngressPayload>({
        accountId: options.accountId,
      });
    }
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<QQBotIngressPayload>({
      queue: getQueue(),
      orderBy: "received",
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof QQBotIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isQQBotAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => options.log?.error(`QQBot ingress: ${message}`),
      dispatchClaimedEvent: async (claimed, lifecycle) => {
        if (claimed.payload.version !== QQBOT_INGRESS_PAYLOAD_VERSION) {
          throw new QQBotIngressPayloadError("QQBot ingress payload version is unsupported.");
        }
        const facts = parseQQBotClaimedEnvelope({
          rawEnvelope: claimed.payload.rawEnvelope,
          claimedId: claimed.id,
          claimedLaneKey: claimed.laneKey,
        });
        // Stage mapping stays claim-side. Receive stores the exact transport envelope.
        const mapped = dispatchEvent(
          facts.eventType,
          facts.payload.d,
          options.accountId,
          options.log,
        );
        if (mapped.action !== "message") {
          throw new QQBotIngressPayloadError(
            `QQBot ingress row ${claimed.id} no longer maps to a message turn.`,
          );
        }
        return await options.dispatch(mapped.msg, lifecycle, claimed.id);
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < QQBOT_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: QQBOT_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: QQBOT_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: QQBOT_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: QQBOT_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
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
      options.log?.error(`QQBot ingress drain failed: ${formatErrorMessage(error)}`);
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

  const timer = setInterval(requestDrain, options.pollIntervalMs ?? QQBOT_INGRESS_POLL_INTERVAL_MS);
  timer.unref?.();
  requestDrain();

  // Socket callbacks can overlap. One admission tail preserves receive order
  // when an earlier append is sleeping through bounded retry backoff.
  let admissionTail: Promise<void> = Promise.resolve();

  const admitOnce = async (rawEnvelope: string): Promise<void> => {
    const facts = inspectQQBotIngressEnvelope(rawEnvelope);
    if (!facts) {
      return;
    }
    const receivedAt = Date.now();
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          facts.eventId,
          {
            version: QQBOT_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            rawEnvelope,
          },
          { receivedAt, laneKey: facts.laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new QQBotIngressAdmissionError("QQBot durable ingress append failed.", {
      cause: lastError,
    });
  };

  return {
    receive: (rawEnvelope) => {
      if (!running) {
        return Promise.reject(new Error("QQBot ingress monitor is stopped."));
      }
      const admission = admissionTail.then(() => admitOnce(rawEnvelope));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      await admissionTail;
      drain?.dispose();
      await pumping;
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
