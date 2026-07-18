// iMessage plugin module owns raw-row durable admission and replay.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getIMessageRuntime } from "../runtime.js";
import { parseIMessageNotification } from "./parse-notification.js";
import type { IMessagePayload } from "./types.js";

const IMESSAGE_INGRESS_PAYLOAD_VERSION = 1;
const IMESSAGE_INGRESS_DRAIN_INTERVAL_MS = 1_000;
const IMESSAGE_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
// Match or exceed the retired GUID guard's 4h / 10k persistent window.
const IMESSAGE_INGRESS_COMPLETED_TTL_MS = 4 * 60 * 60 * 1_000;
const IMESSAGE_INGRESS_COMPLETED_MAX_ENTRIES = 10_000;
const IMESSAGE_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const IMESSAGE_INGRESS_FAILED_MAX_ENTRIES = 1_000;

type IMessageIngressPayload = {
  version: number;
  receivedAt: number;
  raw: unknown;
  /** Operator-requested legacy catchup rows skip the live Push-flush age fence. */
  catchup?: boolean;
};

export type IMessageIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

type IMessageIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type IMessageIngressFacts = {
  eventId: string;
  laneKey: string;
  rowid: number;
  createdAt?: string;
};

type IMessageIngressDispatch = (
  message: IMessagePayload,
  lifecycle: IMessageIngressLifecycle,
  receivedAt: number,
  provenance?: { catchup?: boolean },
) => Promise<IMessageIngressDispatchResult | void> | IMessageIngressDispatchResult | void;

class IMessageIngressPayloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IMessageIngressPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawMessageRecord(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  return isRecord(raw.message) ? raw.message : null;
}

function rawRowid(raw: unknown): number | null {
  const rowid = rawMessageRecord(raw)?.id;
  return typeof rowid === "number" && Number.isSafeInteger(rowid) && rowid >= 0 ? rowid : null;
}

/** Read only stable transport metadata; payload normalization waits for dispatch. */
function inspectIMessageIngress(raw: unknown): IMessageIngressFacts {
  const message = rawMessageRecord(raw);
  const guid = typeof message?.guid === "string" ? message.guid.trim() : "";
  if (!guid) {
    throw new IMessageIngressPayloadError("iMessage ingress row is missing its stable GUID.");
  }
  const rowid = rawRowid(raw);
  if (rowid === null) {
    throw new IMessageIngressPayloadError("iMessage ingress row is missing its ROWID.");
  }
  const chatId = message?.chat_id;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) {
    throw new IMessageIngressPayloadError("iMessage ingress row is missing its chat id.");
  }
  const createdAt = message?.created_at;
  return {
    eventId: guid,
    laneKey: `chat:${chatId}`,
    rowid,
    ...(typeof createdAt === "string" ? { createdAt } : {}),
  };
}

function parseClaimedIMessageIngress(payload: IMessageIngressPayload, eventId: string) {
  if (
    payload.version !== IMESSAGE_INGRESS_PAYLOAD_VERSION ||
    typeof payload.receivedAt !== "number" ||
    !Number.isFinite(payload.receivedAt)
  ) {
    throw new IMessageIngressPayloadError(`iMessage ingress payload ${eventId} is invalid.`);
  }
  let facts: IMessageIngressFacts;
  try {
    facts = inspectIMessageIngress(payload.raw);
  } catch (error) {
    throw new IMessageIngressPayloadError(`iMessage ingress payload ${eventId} is invalid.`, {
      cause: error,
    });
  }
  const message = parseIMessageNotification(payload.raw);
  if (!message || facts.eventId !== eventId) {
    throw new IMessageIngressPayloadError(`iMessage ingress payload ${eventId} is invalid.`);
  }
  return message;
}

function isIMessageAuthenticationFailure(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
    current.original,
  ]).some((candidate) => {
    const message = formatErrorMessage(candidate).toLowerCase();
    return (
      (message.includes("full disk access") && message.includes("chat.db")) ||
      (message.includes("authorization denied") && message.includes("messages"))
    );
  });
}

function resolveIMessageIngressNonRetryableFailure(error: unknown) {
  if (error instanceof IMessageIngressPayloadError) {
    return { reason: "invalid-event", message: error.message };
  }
  if (isIMessageAuthenticationFailure(error)) {
    return { reason: "authentication-failed", message: formatErrorMessage(error) };
  }
  return null;
}

type IMessageDurableIngress = {
  receive: (raw: unknown, opts?: { catchup?: boolean }) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function buildIMessageFlushIngressLifecycle(
  lifecycles: readonly IMessageIngressLifecycle[],
): {
  lifecycle: IMessageIngressLifecycle | undefined;
  settle: () => Promise<void>;
  abandon: () => Promise<void>;
} {
  const first = lifecycles[0];
  if (!first) {
    return { lifecycle: undefined, settle: async () => {}, abandon: async () => {} };
  }
  let handedOff = false;
  const adoptAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAdopted();
    }
  };
  const abandonAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAbandoned();
    }
  };
  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? first.abortSignal
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
        await abandonAll();
      },
    },
    // Gated/no-dispatch turns still consumed every raw row in the flush.
    settle: async () => {
      if (!handedOff) {
        handedOff = true;
        await adoptAll();
      }
    },
    abandon: async () => {
      if (!handedOff) {
        handedOff = true;
        await abandonAll();
      }
    },
  };
}

export function createIMessageDurableIngress(options: {
  accountId: string;
  queue?: ChannelIngressQueue<IMessageIngressPayload>;
  dispatch: IMessageIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  onDurableEnqueue?: (facts: IMessageIngressFacts) => void | Promise<void>;
  onDurableEnqueueFailure?: (rowid: number | null, error: unknown) => void | Promise<void>;
  now?: () => number;
}): IMessageDurableIngress {
  const queue =
    options.queue ??
    getIMessageRuntime().state.openChannelIngressQueue<IMessageIngressPayload>({
      accountId: options.accountId,
    });
  const now = options.now ?? Date.now;
  const dispatchAdmissionQueue = new KeyedAsyncQueue();
  let drain: ChannelIngressDrain | undefined;
  const getDrain = () => {
    drain ??= createChannelIngressDrain<IMessageIngressPayload>({
      queue,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      // Rows retain their per-chat lane in durable state. Claims use a unique
      // core lane so a deferred debounce entry cannot block the later rows it
      // must merge with; this short queue preserves chat order until debounce
      // takes ownership of each claim.
      deriveLaneKey: (record) => `${record.laneKey ?? "event"}:${record.id}`,
      resolveNonRetryableFailure: resolveIMessageIngressNonRetryableFailure,
      onLog: (message) => options.runtime.log?.(`imessage ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) =>
        await dispatchAdmissionQueue.enqueue(record.laneKey ?? record.id, async () => {
          const message = parseClaimedIMessageIngress(record.payload, record.id);
          if (lifecycle.abortSignal.aborted) {
            throw lifecycle.abortSignal.reason;
          }
          return await options.dispatch(
            message,
            lifecycle,
            record.payload.receivedAt,
            record.payload.catchup ? { catchup: true } : {},
          );
        }),
    });
    return drain;
  };
  let running = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = Number.NEGATIVE_INFINITY;
  let admissionTail = Promise.resolve();

  const pruneIfDue = async () => {
    const currentTime = now();
    if (currentTime - lastPrunedAt < IMESSAGE_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await queue.prune({
      completedTtlMs: IMESSAGE_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: IMESSAGE_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: IMESSAGE_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: IMESSAGE_INGRESS_FAILED_MAX_ENTRIES,
      now: currentTime,
    });
    lastPrunedAt = currentTime;
  };

  const runPump = async () => {
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
      options.runtime.error?.(`imessage: ingress drain failed: ${formatErrorMessage(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = () => {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  const receive = async (raw: unknown, receiveOpts?: { catchup?: boolean }) => {
    const admission = admissionTail.then(async () => {
      const rowid = rawRowid(raw);
      try {
        const facts = inspectIMessageIngress(raw);
        await pruneIfDue();
        const receivedAt = now();
        await queue.enqueue(
          facts.eventId,
          {
            version: IMESSAGE_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            raw,
            ...(receiveOpts?.catchup ? { catchup: true } : {}),
          },
          { receivedAt, laneKey: facts.laneKey },
        );
        await options.onDurableEnqueue?.(facts);
        requestDrain();
      } catch (error) {
        await options.onDurableEnqueueFailure?.(rowid, error);
        throw error;
      }
    });
    admissionTail = admission.catch(() => undefined);
    return await admission;
  };

  return {
    receive,
    start: () => {
      if (running) {
        return;
      }
      running = true;
      requestDrain();
      pollTimer = setInterval(requestDrain, IMESSAGE_INGRESS_DRAIN_INTERVAL_MS);
      pollTimer.unref?.();
    },
    stop: async () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      await admissionTail;
      // Source shutdown happens first. Drain every durably accepted row into
      // its deferred owner before disposing claim lifecycles; later restart is
      // then only for genuinely unadopted work.
      requestDrain();
      await pumping;
      running = false;
      await drain?.waitForIdle();
      drain?.dispose();
      drain = undefined;
    },
    waitForIdle: async () => {
      await admissionTail;
      await pumping;
      await drain?.waitForIdle();
    },
  };
}
