/** Shared durable channel-ingress admission, pump, retention, and shutdown lifecycle. */
import { formatErrorMessage } from "../../infra/errors.js";
import { sleep } from "../../utils/sleep.js";
import {
  createChannelIngressDrain,
  type ChannelIngressDrain,
  type CreateChannelIngressDrainOptions,
} from "./ingress-drain.js";
import type { ChannelIngressQueue, ChannelIngressQueueClaim } from "./ingress-queue.js";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "./ingress-retry-policy.js";

const DEFAULT_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

/** Stable identity and serialization lane extracted before durable admission. */
type ChannelIngressMonitorFacts = { eventId: string; laneKey: string };

/** Versioned body presented to a channel's persisted-payload encoder. */
type ChannelIngressPayloadEnvelope<TBody> = { version: number; body: TBody };

/** Claim ownership lifecycle handed to one channel delivery. */
export type ChannelIngressMonitorLifecycle = {
  admission: "exclusive";
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

/** Optional explicit outcome from a channel delivery. */
export type ChannelIngressMonitorDeliveryResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type ChannelIngressMonitorInspectionContext =
  | { phase: "admission" }
  | {
      phase: "claim";
      claimedId: string;
      claimedLaneKey: string | undefined;
    };

type ChannelIngressMonitorClaimErrorKind = "invalid-version" | "identity-mismatch";

type ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata> = {
  version: number;
  serialize: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number },
  ) => TBody;
  deserialize: (
    body: TBody,
    context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
  ) => TRaw;
  createClaimError: (
    kind: ChannelIngressMonitorClaimErrorKind,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) => Error;
} & (
  | (TBody extends string ? { storage: "raw-event" } : never)
  | {
      storage?: "custom";
      encode: (envelope: ChannelIngressPayloadEnvelope<TBody>) => TStoredPayload;
      decode: (
        payload: TStoredPayload,
        context: { claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata> },
      ) => { version: unknown; body: TBody };
    }
);

type ChannelIngressMonitorRetention = {
  pruneIntervalMs: number;
  completedTtlMs?: number;
  completedMaxEntries?: number;
  failedTtlMs?: number;
  failedMaxEntries?: number;
};

type ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata> = Omit<
  CreateChannelIngressDrainOptions<TStoredPayload, TMetadata>,
  "queue" | "dispatchClaimedEvent" | "abortSignal" | "now" | "ownerId" | "claimLeaseMs"
>;

type CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata> = {
  queue:
    | ChannelIngressQueue<TStoredPayload, TMetadata>
    | (() => ChannelIngressQueue<TStoredPayload, TMetadata>);
  inspect: (
    raw: TRaw,
    context: ChannelIngressMonitorInspectionContext,
  ) => ChannelIngressMonitorFacts | null;
  payload: ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata>;
  deliver: (
    raw: TRaw,
    lifecycle: ChannelIngressMonitorLifecycle,
    claim: ChannelIngressQueueClaim<TStoredPayload, TMetadata>,
  ) =>
    | Promise<ChannelIngressMonitorDeliveryResult | void>
    | ChannelIngressMonitorDeliveryResult
    | void;
  pollIntervalMs: number;
  retention: ChannelIngressMonitorRetention;
  appendRetryDelaysMs?: readonly number[];
  drain?: ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata>;
  abortSignal?: AbortSignal;
  now?: () => number;
  onError?: (error: unknown) => void;
  createStoppedError?: () => Error;
  admissionMode?: "until-stopped" | "while-running";
};

/**
 * Creates the shared monitor around a durable queue and ingress drain.
 * Channel code keeps transport inspection, payload shape, and delivery policy.
 */
export function createChannelIngressMonitor<TRaw, TBody, TStoredPayload, TMetadata = unknown>(
  options: CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata>,
) {
  const now = options.now ?? Date.now;
  const appendRetryDelaysMs = options.appendRetryDelaysMs ?? DEFAULT_APPEND_RETRY_DELAYS_MS;
  const { pruneIntervalMs, ...pruneOptions } = options.retention;
  const shutdown = new AbortController();
  const drainAbortSignal = options.abortSignal
    ? AbortSignal.any([shutdown.signal, options.abortSignal])
    : shutdown.signal;
  const activeDeliveries = new Set<Promise<unknown>>();
  type Queue = ChannelIngressQueue<TStoredPayload, TMetadata>;
  const queueFactory: () => Queue =
    typeof options.queue === "function" ? options.queue : () => options.queue as Queue;
  let queue: Queue | undefined = typeof options.queue === "function" ? undefined : options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = false;
  let stopped = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  let stopTask: Promise<void> | undefined;

  const createStoppedError = () =>
    options.createStoppedError?.() ?? new Error("Channel ingress monitor is stopped.");

  const getQueue = (): Queue => (queue ??= queueFactory());

  const isAborted = () => drainAbortSignal.aborted;

  const waitForActiveDeliveries = async (): Promise<void> => {
    while (activeDeliveries.size > 0) {
      await Promise.allSettled(activeDeliveries);
    }
  };

  const waitForPumpIdle = async (): Promise<void> => {
    for (;;) {
      const activePump = pumping;
      if (!activePump) {
        return;
      }
      await activePump;
    }
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<TStoredPayload, TMetadata>({
      ...options.drain,
      queue: getQueue(),
      abortSignal: drainAbortSignal,
      now,
      retryPolicy: options.drain?.retryPolicy ?? {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      formatError: options.drain?.formatError ?? formatErrorMessage,
      dispatchClaimedEvent: async (claim, lifecycle) => {
        if (!running || isAborted() || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: createStoppedError() };
        }
        let decoded: { version: unknown; body: TBody };
        if (options.payload.storage === "raw-event") {
          const stored = claim.payload as { version?: unknown; rawEvent?: unknown };
          if (!stored || typeof stored.rawEvent !== "string") {
            throw options.payload.createClaimError("invalid-version", claim);
          }
          decoded = { version: stored.version, body: stored.rawEvent as TBody };
        } else {
          decoded = options.payload.decode(claim.payload, { claim });
        }
        if (decoded.version !== options.payload.version) {
          throw options.payload.createClaimError("invalid-version", claim);
        }
        const raw = options.payload.deserialize(decoded.body, { claim });
        const facts = options.inspect(raw, {
          phase: "claim",
          claimedId: claim.id,
          claimedLaneKey: claim.laneKey,
        });
        if (!facts || facts.eventId !== claim.id || facts.laneKey !== claim.laneKey) {
          throw options.payload.createClaimError("identity-mismatch", claim);
        }

        let handedOff = false;
        let deferredHandoff = false;
        const wrappedLifecycle: ChannelIngressMonitorLifecycle = {
          ...lifecycle,
          admission: "exclusive",
          onAdopted: async () => {
            handedOff = true;
            await lifecycle.onAdopted();
          },
          onDeferred: () => {
            handedOff = true;
            deferredHandoff = true;
            lifecycle.onDeferred();
          },
          onAdoptionFinalizing: () => {
            handedOff = true;
            deferredHandoff = true;
            lifecycle.onAdoptionFinalizing();
          },
          onAbandoned: async () => {
            handedOff = true;
            deferredHandoff = true;
            await lifecycle.onAbandoned();
          },
        };

        // Adoption can complete before delivery returns; track both lifetimes so stop
        // never drops channel work merely because the durable claim already settled.
        const delivery = Promise.resolve().then(() =>
          options.deliver(raw, wrappedLifecycle, claim),
        );
        activeDeliveries.add(delivery);
        let result: ChannelIngressMonitorDeliveryResult | void;
        try {
          result = await delivery;
        } catch (error) {
          if (isAborted() || lifecycle.abortSignal.aborted) {
            return { kind: "failed-retryable", error };
          }
          throw error;
        } finally {
          activeDeliveries.delete(delivery);
        }
        if (result?.kind === "failed-retryable") {
          return result;
        }
        if (isAborted() || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: createStoppedError() };
        }
        if (result?.kind === "deferred") {
          if (!deferredHandoff) {
            wrappedLifecycle.onDeferred();
          }
          return { kind: "deferred" };
        }
        if (!handedOff) {
          // A policy gate or deliberate no-dispatch is terminal for transport replay.
          await wrappedLifecycle.onAdopted();
        }
        return deferredHandoff ? { kind: "deferred" } : { kind: "completed" };
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const currentTime = now();
    if (currentTime - lastPrunedAt < pruneIntervalMs) {
      return;
    }
    await getQueue().prune({ ...pruneOptions, now: currentTime });
    lastPrunedAt = currentTime;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // Stop may win the async prune race; keep lazy drain creation behind this fence.
        if (!running || isAborted()) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce({
          shouldStop: () =>
            !running ||
            isAborted() ||
            (options.drain?.startLimit !== undefined &&
              activeDeliveries.size >= options.drain.startLimit),
        });
        await waitForActiveDeliveries();
        await activeDrain.waitForIdle();
        if (!running || isAborted() || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      pumping = undefined;
      if (running && !isAborted() && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    if (!running || isAborted() || pumping) {
      return;
    }
    pumping = runPump();
  };

  const clearPollTimer = () => {
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const pause = async (): Promise<void> => {
    running = false;
    requested = false;
    clearPollTimer();
    await waitForPumpIdle();
  };

  const admitOnce = async (params: {
    facts: ChannelIngressMonitorFacts;
    payload: TStoredPayload;
    receivedAt: number;
  }): Promise<void> => {
    let lastError: unknown;
    for (const delayMs of appendRetryDelaysMs) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        await getQueue().enqueue(params.facts.eventId, params.payload, {
          receivedAt: params.receivedAt,
          laneKey: params.facts.laneKey,
        });
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // Accepted transport input must fail closed if every durable append attempt fails.
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(
      lastError === undefined
        ? "Channel ingress append failed without an error."
        : formatErrorMessage(lastError),
      { cause: lastError },
    );
  };

  return {
    admit: async (
      raw: TRaw,
      admitOptions?: { receivedAt?: number; facts?: ChannelIngressMonitorFacts },
    ) => {
      if (
        stopped ||
        (options.admissionMode === "while-running" && !running) ||
        options.abortSignal?.aborted
      ) {
        throw createStoppedError();
      }
      const facts = admitOptions?.facts ?? options.inspect(raw, { phase: "admission" });
      if (!facts) {
        return { kind: "ignored" } as const;
      }
      const receivedAt = admitOptions?.receivedAt ?? now();
      const body = options.payload.serialize(raw, { facts, receivedAt });
      const payload =
        options.payload.storage === "raw-event"
          ? ({ version: options.payload.version, rawEvent: body } as TStoredPayload)
          : options.payload.encode({ version: options.payload.version, body });
      // Append retries stay serialized so backoff cannot invert one lane's arrival order.
      const admission = admissionTail.then(() => admitOnce({ facts, payload, receivedAt }));
      admissionTail = admission.catch(() => undefined);
      await admission;
      return { kind: "durable" } as const;
    },
    start: () => {
      if (running || stopped || isAborted()) {
        return;
      }
      running = true;
      pollTimer = setInterval(requestDrain, options.pollIntervalMs);
      pollTimer.unref?.();
      requestDrain();
    },
    pause,
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        running = false;
        requested = false;
        clearPollTimer();
        // Every transport callback accepted before stop keeps its durable-append guarantee.
        await admissionTail;
        shutdown.abort(createStoppedError());
        drain?.dispose();
        await waitForPumpIdle();
        await waitForActiveDeliveries();
        // A pump may have created the lazy drain just before observing running=false.
        drain?.dispose();
        await drain?.waitForIdle();
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      await admissionTail;
      await waitForPumpIdle();
      await waitForActiveDeliveries();
      await drain?.waitForIdle();
    },
    isRunning: () => running,
    isStopped: () => stopped,
  };
}
