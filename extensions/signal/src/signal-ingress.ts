// Signal plugin module owns raw-envelope durable ingress mapping and draining.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SignalSseEvent } from "./client-adapter.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const SIGNAL_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_INGRESS_COMPLETED_MAX_ENTRIES = 1000;
const SIGNAL_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_INGRESS_FAILED_MAX_ENTRIES = 1000;
const SIGNAL_INGRESS_DRAIN_INTERVAL_MS = 1_000;

type SignalIngressEnvelope = {
  sourceNumber?: unknown;
  sourceUuid?: unknown;
  timestamp?: unknown;
  syncMessage?: unknown;
  dataMessage?: unknown;
  editMessage?: { dataMessage?: unknown } | null;
  reactionMessage?: unknown;
};

type SignalIngressEventFacts = {
  eventId: string;
  laneKey: string;
};

type SignalIngressPayload = {
  version: 1;
  receivedAt: number;
  event: SignalSseEvent;
};

export type SignalIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

type SignalIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type SignalIngressDispatch = (
  event: SignalSseEvent,
  lifecycle: SignalIngressLifecycle,
) => Promise<SignalIngressDispatchResult | void> | SignalIngressDispatchResult | void;

class SignalIngressPermanentError extends Error {
  constructor(
    readonly reason: "parse-error" | "missing-sender" | "missing-timestamp" | "unsupported-event",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SignalIngressPermanentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRawString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseReceiveEnvelope(event: SignalSseEvent): SignalIngressEnvelope | null {
  if (event.event !== "receive" || !event.data) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch (error) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event contains invalid JSON",
      {
        cause: error,
      },
    );
  }
  if (!isRecord(parsed)) {
    throw new SignalIngressPermanentError(
      "parse-error",
      "Signal receive event must contain a JSON object",
    );
  }
  return isRecord(parsed.envelope) ? (parsed.envelope as SignalIngressEnvelope) : null;
}

function resolveDataMessage(envelope: SignalIngressEnvelope): Record<string, unknown> | null {
  if (isRecord(envelope.dataMessage)) {
    return envelope.dataMessage;
  }
  return isRecord(envelope.editMessage?.dataMessage) ? envelope.editMessage.dataMessage : null;
}

function inspectSignalIngressEvent(event: SignalSseEvent): SignalIngressEventFacts | null {
  const envelope = parseReceiveEnvelope(event);
  if (!envelope || "syncMessage" in envelope) {
    return null;
  }
  const dataMessage = resolveDataMessage(envelope);
  const reactionMessage = isRecord(envelope.reactionMessage) ? envelope.reactionMessage : null;
  if (!dataMessage && !reactionMessage) {
    // Receipts, typing notifications, and other transport-only envelopes never dispatch.
    return null;
  }
  const senderUuid = normalizeRawString(envelope.sourceUuid);
  const senderNumber = normalizeRawString(envelope.sourceNumber);
  const senderKey = senderUuid
    ? `uuid:${senderUuid}`
    : senderNumber
      ? `number:${senderNumber}`
      : null;
  if (!senderKey) {
    throw new SignalIngressPermanentError(
      "missing-sender",
      "Signal dispatchable envelope is missing sourceUuid/sourceNumber",
    );
  }
  const timestamp =
    normalizeTimestamp(envelope.timestamp) ?? normalizeTimestamp(dataMessage?.timestamp);
  if (timestamp === null) {
    throw new SignalIngressPermanentError(
      "missing-timestamp",
      "Signal dispatchable envelope is missing a stable timestamp",
    );
  }
  const dataGroup = isRecord(dataMessage?.groupInfo) ? dataMessage.groupInfo : null;
  const reactionGroup = isRecord(reactionMessage?.groupInfo) ? reactionMessage.groupInfo : null;
  const groupId =
    normalizeRawString(dataGroup?.groupId) ?? normalizeRawString(reactionGroup?.groupId);
  return {
    eventId: JSON.stringify([senderKey, timestamp]),
    laneKey: groupId ? `group:${groupId}` : `direct:${senderKey}`,
  };
}

type SignalIngressEnqueueResult =
  | Awaited<ReturnType<ChannelIngressQueue<SignalIngressPayload>["enqueue"]>>
  | { kind: "ignored" };

/** Durable receive chokepoint. Metadata comes from raw fields; payload stays byte-equivalent JSON. */
async function enqueueSignalIngressEvent(params: {
  queue: ChannelIngressQueue<SignalIngressPayload>;
  event: SignalSseEvent;
  now?: number;
}): Promise<SignalIngressEnqueueResult> {
  const facts = inspectSignalIngressEvent(params.event);
  if (!facts) {
    return { kind: "ignored" };
  }
  const receivedAt = params.now ?? Date.now();
  await params.queue.prune({
    completedTtlMs: SIGNAL_INGRESS_COMPLETED_TTL_MS,
    completedMaxEntries: SIGNAL_INGRESS_COMPLETED_MAX_ENTRIES,
    failedTtlMs: SIGNAL_INGRESS_FAILED_TTL_MS,
    failedMaxEntries: SIGNAL_INGRESS_FAILED_MAX_ENTRIES,
    ...(params.now === undefined ? {} : { now: params.now }),
  });
  return await params.queue.enqueue(
    facts.eventId,
    { version: 1, receivedAt, event: params.event },
    { receivedAt, laneKey: facts.laneKey },
  );
}

function resolveSignalIngressNonRetryableFailure(error: unknown) {
  return error instanceof SignalIngressPermanentError
    ? { reason: error.reason, message: error.message }
    : null;
}

function createSignalIngressDrain(params: {
  queue: ChannelIngressQueue<SignalIngressPayload>;
  dispatch: SignalIngressDispatch;
  abortSignal?: AbortSignal;
  onLog?: (message: string) => void;
}): ChannelIngressDrain {
  return createChannelIngressDrain<SignalIngressPayload>({
    queue: params.queue,
    retryPolicy: {
      maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    },
    resolveNonRetryableFailure: resolveSignalIngressNonRetryableFailure,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    dispatchClaimedEvent: async (record, lifecycle) => {
      if (!inspectSignalIngressEvent(record.payload.event)) {
        throw new SignalIngressPermanentError(
          "unsupported-event",
          "Signal ingress row no longer contains a dispatchable envelope",
        );
      }
      return await params.dispatch(record.payload.event, lifecycle);
    },
  });
}

export type SignalIngressMonitor = {
  receive: (event: SignalSseEvent) => Promise<void>;
  stop: () => Promise<void>;
};

/** Open the account queue, recover it, and keep newly appended rows draining. */
export async function startSignalIngressMonitor(params: {
  accountId: string;
  queue?: ChannelIngressQueue<SignalIngressPayload>;
  dispatch: SignalIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  runTrackedTask: (task: () => Promise<void>) => void;
}): Promise<SignalIngressMonitor> {
  let queue = params.queue;
  if (!queue) {
    const pluginRuntime = getOptionalSignalRuntime();
    if (!pluginRuntime) {
      throw new Error("Signal runtime not initialized for durable ingress");
    }
    queue = pluginRuntime.state.openChannelIngressQueue<SignalIngressPayload>({
      accountId: params.accountId,
    });
  }
  const drain = createSignalIngressDrain({
    queue,
    dispatch: params.dispatch,
    onLog: (message) => params.runtime.log?.(`signal ${message}`),
  });
  let drainPass: Promise<void> | undefined;
  let drainRequested = false;

  const requestDrain = (): Promise<void> => {
    drainRequested = true;
    if (!drainPass) {
      drainPass = (async () => {
        while (drainRequested) {
          drainRequested = false;
          const result = await drain.drainOnce();
          if (result.started > 0) {
            params.runTrackedTask(async () => {
              await drain.waitForIdle();
              await requestDrain();
            });
          }
        }
      })().finally(() => {
        drainPass = undefined;
        if (drainRequested) {
          void requestDrain().catch((error: unknown) => {
            params.runtime.error?.(`signal ingress drain failed: ${String(error)}`);
          });
        }
      });
    }
    return drainPass;
  };

  await requestDrain();
  const timer = setInterval(() => {
    void requestDrain().catch((error: unknown) => {
      params.runtime.error?.(`signal ingress drain failed: ${String(error)}`);
    });
  }, SIGNAL_INGRESS_DRAIN_INTERVAL_MS);
  timer.unref?.();

  return {
    receive: async (event) => {
      const result = await enqueueSignalIngressEvent({ queue, event });
      if (result.kind !== "ignored") {
        await requestDrain();
      }
    },
    stop: async () => {
      clearInterval(timer);
      await drainPass?.catch(() => undefined);
      drain.dispose();
    },
  };
}
