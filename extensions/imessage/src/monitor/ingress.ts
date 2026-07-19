// iMessage plugin module owns raw-row durable admission and replay.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
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

type IMessageIngressBody = Omit<IMessageIngressPayload, "version">;

type IMessageIngressRaw = {
  raw: unknown;
  catchup?: boolean;
  receivedAt?: number;
  message?: IMessagePayload;
};

export type IMessageIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

type IMessageIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

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

function decodeIMessageIngressPayload(
  payload: IMessageIngressPayload,
  eventId: string,
): { version: unknown; body: IMessageIngressBody } {
  if (typeof payload.receivedAt !== "number" || !Number.isFinite(payload.receivedAt)) {
    throw new IMessageIngressPayloadError(`iMessage ingress payload ${eventId} is invalid.`);
  }
  return {
    version: payload.version,
    body: {
      receivedAt: payload.receivedAt,
      raw: payload.raw,
      ...(payload.catchup ? { catchup: true } : {}),
    },
  };
}

function deserializeIMessageIngress(
  body: IMessageIngressBody,
  eventId: string,
): IMessageIngressRaw {
  const message = parseIMessageNotification(body.raw);
  if (!message) {
    throw new IMessageIngressPayloadError(`iMessage ingress payload ${eventId} is invalid.`);
  }
  return {
    raw: body.raw,
    receivedAt: body.receivedAt,
    message,
    ...(body.catchup ? { catchup: true } : {}),
  };
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
  const monitor = createChannelIngressMonitor<
    IMessageIngressRaw,
    IMessageIngressBody,
    IMessageIngressPayload
  >({
    queue,
    inspect: (event, context) => {
      try {
        return inspectIMessageIngress(event.raw);
      } catch (error) {
        if (context.phase === "claim") {
          throw new IMessageIngressPayloadError(
            `iMessage ingress payload ${context.claimedId} is invalid.`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    payload: {
      version: IMESSAGE_INGRESS_PAYLOAD_VERSION,
      serialize: (event, { receivedAt }) => ({
        receivedAt,
        raw: event.raw,
        ...(event.catchup ? { catchup: true } : {}),
      }),
      deserialize: (body, { claim }) => deserializeIMessageIngress(body, claim.id),
      encode: ({ body }) => ({ version: IMESSAGE_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeIMessageIngressPayload(payload, claim.id),
      createClaimError: (_kind, claim) =>
        new IMessageIngressPayloadError(`iMessage ingress payload ${claim.id} is invalid.`),
    },
    deliver: async (event, lifecycle, record) =>
      await dispatchAdmissionQueue.enqueue(record.laneKey ?? record.id, async () => {
        if (!event.message || event.receivedAt === undefined) {
          throw new IMessageIngressPayloadError(
            `iMessage ingress payload ${record.id} is invalid.`,
          );
        }
        if (lifecycle.abortSignal.aborted) {
          throw lifecycle.abortSignal.reason;
        }
        return await options.dispatch(
          event.message,
          lifecycle,
          event.receivedAt,
          event.catchup ? { catchup: true } : {},
        );
      }),
    pollIntervalMs: IMESSAGE_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      pruneIntervalMs: IMESSAGE_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: IMESSAGE_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: IMESSAGE_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: IMESSAGE_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: IMESSAGE_INGRESS_FAILED_MAX_ENTRIES,
    },
    appendRetryDelaysMs: [0],
    onDurableAdmission: async (event) => {
      await options.onDurableEnqueue?.(inspectIMessageIngress(event.raw));
    },
    onAdmissionFailure: async (event, error) => {
      await options.onDurableEnqueueFailure?.(rawRowid(event.raw), error);
    },
    drain: {
      // Rows retain their per-chat lane in durable state. Claims use a unique
      // core lane so a deferred debounce entry cannot block the later rows it
      // must merge with; this short queue preserves chat order until debounce
      // takes ownership of each claim.
      deriveLaneKey: (record) => `${record.laneKey ?? "event"}:${record.id}`,
      resolveNonRetryableFailure: resolveIMessageIngressNonRetryableFailure,
      onLog: (message) => options.runtime.log?.(`imessage ${message}`),
    },
    now,
    onError: (error) =>
      options.runtime.error?.(`imessage: ingress drain failed: ${formatErrorMessage(error)}`),
  });
  let stopTask: Promise<void> | undefined;

  return {
    receive: async (raw, receiveOpts) => {
      await monitor.admit({ raw, ...(receiveOpts?.catchup ? { catchup: true } : {}) });
    },
    start: monitor.start,
    stop: () => {
      stopTask ??= (async () => {
        // iMessage debounce must own every accepted claim before disposal so a
        // restart replays only rows that were never handed to a flush.
        await monitor.waitForIdle();
        await monitor.stop();
      })();
      return stopTask;
    },
    waitForIdle: monitor.waitForIdle,
  };
}
