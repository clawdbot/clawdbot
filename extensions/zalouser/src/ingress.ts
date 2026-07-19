// Zalouser plugin owns raw zca-js message admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { getZalouserRuntime } from "./runtime.js";
import type { ZaloInboundMessage } from "./types.js";
import { normalizeZaloInboundMessage } from "./zalo-js.js";
import type { Message } from "./zca-client.js";
import { ThreadType } from "./zca-constants.js";

const ZALOUSER_INGRESS_PAYLOAD_VERSION = 1;
const ZALOUSER_INGRESS_POLL_INTERVAL_MS = 1_000;
const ZALOUSER_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const ZALOUSER_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ZALOUSER_INGRESS_COMPLETED_MAX_ENTRIES = 1_000;
const ZALOUSER_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ZALOUSER_INGRESS_FAILED_MAX_ENTRIES = 1_000;
const ZALOUSER_INGRESS_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

type ZalouserIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: string;
};

export type ZalouserIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

type ZalouserIngressDispatch = (
  message: ZaloInboundMessage,
  lifecycle: ZalouserIngressLifecycle,
) => Promise<void> | void;

type ZalouserIngressMonitor = {
  receive: (message: Message) => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

class ZalouserIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZalouserIngressPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectZalouserIngressMessage(message: unknown): {
  eventId: string;
  laneKey: string;
} {
  if (!isRecord(message) || !isRecord(message.data)) {
    throw new ZalouserIngressPayloadError("zca-js message envelope must contain data.");
  }
  const eventId = nonEmptyString(message.data.msgId);
  if (!eventId) {
    throw new ZalouserIngressPayloadError("zca-js message envelope is missing data.msgId.");
  }
  if (message.type === ThreadType.Group) {
    const groupId = nonEmptyString(message.data.idTo);
    if (!groupId) {
      throw new ZalouserIngressPayloadError("zca-js group message is missing data.idTo.");
    }
    return { eventId, laneKey: `group:${groupId}` };
  }
  if (message.type !== ThreadType.User) {
    throw new ZalouserIngressPayloadError("zca-js message has an unsupported thread type.");
  }
  const senderId = nonEmptyString(message.data.uidFrom);
  if (!senderId) {
    throw new ZalouserIngressPayloadError("zca-js direct message is missing data.uidFrom.");
  }
  return { eventId, laneKey: `direct:${senderId}` };
}

function serializeZalouserIngressMessage(message: Message): string {
  try {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") {
      throw new ZalouserIngressPayloadError("zca-js message envelope is not serializable.");
    }
    return serialized;
  } catch (error) {
    if (error instanceof ZalouserIngressPayloadError) {
      throw error;
    }
    throw new ZalouserIngressPayloadError("zca-js message envelope is not serializable.", {
      cause: error,
    });
  }
}

function parseClaimedMessage(
  payload: unknown,
  claimedId: string,
  claimedLaneKey: string | undefined,
  ownUserId: string,
): ZaloInboundMessage {
  if (
    !isRecord(payload) ||
    payload.version !== ZALOUSER_INGRESS_PAYLOAD_VERSION ||
    typeof payload.rawMessage !== "string"
  ) {
    throw new ZalouserIngressPayloadError("Zalouser ingress payload is invalid.");
  }
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(payload.rawMessage);
  } catch (error) {
    throw new ZalouserIngressPayloadError("Zalouser ingress message JSON is invalid.", {
      cause: error,
    });
  }
  const facts = inspectZalouserIngressMessage(rawMessage);
  if (facts.eventId !== claimedId || facts.laneKey !== claimedLaneKey) {
    throw new ZalouserIngressPayloadError(
      "Zalouser message identity changed after durable admission.",
    );
  }
  const normalized = normalizeZaloInboundMessage(rawMessage as Message, ownUserId);
  if (!normalized) {
    throw new ZalouserIngressPayloadError("Zalouser message could not be normalized.");
  }
  return normalized;
}

function isZalouserAuthenticationFailure(error: unknown): boolean {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    const code = extractErrorCode(candidate);
    const record = candidate as { status?: unknown; statusCode?: unknown };
    if (
      code === "401" ||
      code === "403" ||
      record.status === 401 ||
      record.status === 403 ||
      record.statusCode === 401 ||
      record.statusCode === 403
    ) {
      return true;
    }
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createZalouserIngressMonitor(options: {
  accountId: string;
  ownUserId: string;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: ZalouserIngressDispatch;
  queue?: ChannelIngressQueue<ZalouserIngressPayload>;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): ZalouserIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = true;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  let stopTask: Promise<void> | undefined;
  const shutdown = new AbortController();
  const activeDeliveries = new Set<Promise<void>>();
  const deferredClaims = new Map<string, Promise<void>>();

  const getQueue = (): ChannelIngressQueue<ZalouserIngressPayload> => {
    queue ??= getZalouserRuntime().state.openChannelIngressQueue<ZalouserIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<ZalouserIngressPayload>({
      queue: getQueue(),
      orderBy: "received",
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      abortSignal: shutdown.signal,
      resolveNonRetryableFailure: (error) => {
        if (error instanceof ZalouserIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isZalouserAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: errorText(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(`zalouser ingress: ${message}`),
      dispatchClaimedEvent: async (claimed, lifecycle) => {
        if (!running || lifecycle.abortSignal.aborted) {
          return {
            kind: "failed-retryable",
            error: new Error("Zalouser ingress stopped before dispatch."),
          };
        }
        const message = parseClaimedMessage(
          claimed.payload,
          claimed.id,
          claimed.laneKey,
          options.ownUserId,
        );
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
          lifecycle.abortSignal.removeEventListener("abort", settleDeferredClaim);
          if (deferredClaims.get(claimed.id) === deferredClaim) {
            deferredClaims.delete(claimed.id);
          }
          resolveDeferredClaim();
          requestDrain();
        };
        // The drain can guillotine or dispose a deferred claim without invoking
        // the reply lifecycle again. Release local bookkeeping on that abort.
        lifecycle.abortSignal.addEventListener("abort", settleDeferredClaim, { once: true });
        if (lifecycle.abortSignal.aborted) {
          settleDeferredClaim();
        }
        const delivery = Promise.resolve(
          options.dispatch(message, {
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
          }),
        );
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
            return {
              kind: "failed-retryable",
              error: new Error("Zalouser ingress stopped before adoption."),
            };
          }
          // Policy gates and deliberate no-dispatch turns are terminal.
          await bound.onAdopted();
        }
        return deferredClaims.has(claimed.id) ? { kind: "deferred" } : { kind: "completed" };
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < ZALOUSER_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: ZALOUSER_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: ZALOUSER_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: ZALOUSER_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: ZALOUSER_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() can run during the async prune; never start a claim afterwards.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`zalouser ingress drain failed: ${errorText(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  function requestDrain(): void {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  }

  const timer = setInterval(
    requestDrain,
    options.pollIntervalMs ?? ZALOUSER_INGRESS_POLL_INTERVAL_MS,
  );
  timer.unref?.();
  requestDrain();

  const admitOnce = async (message: Message): Promise<void> => {
    const facts = inspectZalouserIngressMessage(message);
    const rawMessage = serializeZalouserIngressMessage(message);
    const receivedAt = Date.now();
    let lastError: unknown;
    for (const delayMs of ZALOUSER_INGRESS_APPEND_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          facts.eventId,
          {
            version: ZALOUSER_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            rawMessage,
          },
          { receivedAt, laneKey: facts.laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Zalouser durable ingress append failed.", { cause: lastError });
  };

  return {
    receive: (message) => {
      if (!running) {
        return Promise.reject(new Error("Zalouser ingress monitor is stopped."));
      }
      // zca-js callbacks can overlap. Preserve arrival order through append backoff.
      const admission = admissionTail.then(() => admitOnce(message));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    stop: () => {
      stopTask ??= (async () => {
        running = false;
        clearInterval(timer);
        await admissionTail;
        shutdown.abort(new Error("Zalouser ingress stopped."));
        await pumping;
        await Promise.allSettled(activeDeliveries);
        // Abort deferred per-claim lifecycles so their durable rows stay available
        // for recovery instead of holding shutdown open indefinitely.
        drain?.dispose();
        await Promise.allSettled(deferredClaims.values());
        await drain?.waitForIdle();
        // Dispose remains safe if monitor cleanup repeats.
        drain?.dispose();
        drain?.dispose();
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      await admissionTail;
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
