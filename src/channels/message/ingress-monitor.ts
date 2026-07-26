/** Shared durable channel-ingress admission, pump, retention, and shutdown lifecycle. */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
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
  pendingTtlMs?: number;
  pendingMaxEntries?: number;
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
  onDurableAdmission?: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number },
  ) => void | Promise<void>;
  onAdmissionFailure?: (raw: TRaw, error: unknown) => void | Promise<void>;
  /** False lets repeated requests fill drain capacity while earlier claims remain active. */
  waitForDeliveryIdleBeforeRepump?: boolean;
  /** Runs each pump under a channel-owned async context such as a detached request root. */
  runPumpTask?: (work: () => Promise<void>) => Promise<void>;
  /** False lets a channel apply its own bounded delivery grace before final disposal. */
  waitForDeliveryIdleOnStop?: boolean;
  drain?: ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata>;
  abortSignal?: AbortSignal;
  now?: () => number;
  onError?: (error: unknown) => void;
  onActivityChange?: (active: boolean) => void;
  createStoppedError?: () => Error;
  /** Durable-after-stop preserves append-only admission for handlers selected before unregister. */
  admissionMode?: "until-stopped" | "while-running" | "durable-after-stop";
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
  const waitForDeliveryIdleBeforeRepump = options.waitForDeliveryIdleBeforeRepump ?? false;
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
  let drainIdleWake: Promise<void> | undefined;
  let drainIdleWakeRequested = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  let admissionClaimLocked = false;
  const admissionClaimWaiters: Array<() => void> = [];
  let stopTask: Promise<void> | undefined;
  let lastReportedActive = false;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Observers must not be able to corrupt ingress bookkeeping.
    }
  };

  const publishActivity = (): void => {
    const active = activeDeliveries.size > 0 || (running && (requested || pumping !== undefined));
    if (active === lastReportedActive) {
      return;
    }
    lastReportedActive = active;
    try {
      options.onActivityChange?.(active);
    } catch (error) {
      reportError(error);
    }
  };

  const withAdmissionClaimLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = (): Promise<T> => {
      admissionClaimLocked = true;
      let result: Promise<T>;
      try {
        result = Promise.resolve(task());
      } catch (error) {
        result = Promise.reject(toErrorObject(error, "Channel ingress admission task failed"));
      }
      return result.finally(() => {
        const next = admissionClaimWaiters.shift();
        if (next) {
          next();
        } else {
          admissionClaimLocked = false;
        }
      });
    };
    if (!admissionClaimLocked) {
      return run();
    }
    return new Promise<T>((resolve, reject) => {
      admissionClaimWaiters.push(() => {
        void run().then(resolve, reject);
      });
    });
  };

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
        const claimedLaneKey = claim.laneKey ?? options.drain?.deriveLaneKey?.(claim);
        const facts = options.inspect(raw, {
          phase: "claim",
          claimedId: claim.id,
          claimedLaneKey,
        });
        if (!facts || facts.eventId !== claim.id || facts.laneKey !== claimedLaneKey) {
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
            requestDrain();
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
            requestDrain();
          },
        };

        // Adoption can complete before delivery returns; track both lifetimes so stop
        // never drops channel work merely because the durable claim already settled.
        const delivery = Promise.resolve().then(() =>
          options.deliver(raw, wrappedLifecycle, claim),
        );
        activeDeliveries.add(delivery);
        publishActivity();
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
          publishActivity();
        }
        if (result?.kind === "failed-retryable") {
          return result;
        }
        if (isAborted() || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: createStoppedError() };
        }
        if (result?.kind === "completed") {
          return result;
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

  const scheduleDrainIdleWake = (activeDrain: ChannelIngressDrain): void => {
    if (drainIdleWake) {
      drainIdleWakeRequested = true;
      return;
    }
    drainIdleWakeRequested = false;
    const wake = activeDrain.waitForIdle();
    drainIdleWake = wake;
    void wake.then(
      () => {
        if (drainIdleWake !== wake) {
          return;
        }
        const shouldRearm = drainIdleWakeRequested && running && !isAborted();
        drainIdleWake = undefined;
        drainIdleWakeRequested = false;
        if (shouldRearm) {
          scheduleDrainIdleWake(activeDrain);
        }
        requestDrain();
      },
      (error: unknown) => {
        if (drainIdleWake === wake) {
          drainIdleWake = undefined;
          drainIdleWakeRequested = false;
        }
        reportError(error);
      },
    );
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
        // Claiming and durable admission are mutually exclusive so a row cannot
        // dispatch before its transport-owned post-append acknowledgement finishes.
        const { started } = await withAdmissionClaimLock(() =>
          activeDrain.drainOnce({
            shouldStop: () =>
              !running ||
              isAborted() ||
              (options.drain?.startLimit !== undefined &&
                activeDeliveries.size >= options.drain.startLimit),
          }),
        );
        if (waitForDeliveryIdleBeforeRepump) {
          await waitForActiveDeliveries();
          await activeDrain.waitForIdle();
        } else if (started > 0) {
          // Failed-retryable delivery settles after the channel callback returns.
          // Wake once the drain has released or failed those claims.
          scheduleDrainIdleWake(activeDrain);
        }
        if (
          !running ||
          isAborted() ||
          (!requested && (!waitForDeliveryIdleBeforeRepump || started === 0))
        ) {
          break;
        }
      }
    } catch (error) {
      reportError(error);
    } finally {
      pumping = undefined;
      if (!running || isAborted()) {
        requested = false;
      } else if (requested) {
        requestDrain();
      }
      publishActivity();
    }
  };

  const requestDrain = (): void => {
    if (!running || isAborted()) {
      publishActivity();
      return;
    }
    requested = true;
    if (pumping) {
      publishActivity();
      return;
    }
    pumping = options.runPumpTask ? options.runPumpTask(runPump) : runPump();
    publishActivity();
  };

  const clearPollTimer = () => {
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const pause = async (): Promise<void> => {
    running = false;
    requested = false;
    clearPollTimer();
    publishActivity();
    await waitForPumpIdle();
  };

  const admitOnce = async (params: {
    facts: ChannelIngressMonitorFacts;
    payload: TStoredPayload;
    receivedAt: number;
  }): Promise<Awaited<ReturnType<Queue["enqueue"]>>> => {
    let lastError: unknown;
    for (const delayMs of appendRetryDelaysMs) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        const result = await getQueue().enqueue(params.facts.eventId, params.payload, {
          receivedAt: params.receivedAt,
          laneKey: params.facts.laneKey,
        });
        return result;
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

  const assertAdmissionOpen = (): void => {
    if (
      (stopped && options.admissionMode !== "durable-after-stop") ||
      (options.admissionMode === "while-running" && !running) ||
      (options.abortSignal?.aborted && options.admissionMode !== "durable-after-stop")
    ) {
      throw createStoppedError();
    }
  };

  const admitRaw = async (
    raw: TRaw,
    admitOptions: {
      receivedAt: number;
      facts?: ChannelIngressMonitorFacts;
      onDurablyAdmitted: () => void;
    },
  ) => {
    try {
      const facts = admitOptions.facts ?? options.inspect(raw, { phase: "admission" });
      if (!facts) {
        return { kind: "ignored" } as const;
      }
      const body = options.payload.serialize(raw, { facts, receivedAt: admitOptions.receivedAt });
      const payload =
        options.payload.storage === "raw-event"
          ? ({ version: options.payload.version, rawEvent: body } as TStoredPayload)
          : options.payload.encode({ version: options.payload.version, body });
      const queueResult = await admitOnce({
        facts,
        payload,
        receivedAt: admitOptions.receivedAt,
      });
      admitOptions.onDurablyAdmitted();
      await options.onDurableAdmission?.(raw, { facts, receivedAt: admitOptions.receivedAt });
      return { kind: "durable", queueResult } as const;
    } catch (error) {
      await options.onAdmissionFailure?.(raw, error);
      throw error;
    }
  };

  const scheduleAdmission = <T>(work: () => Promise<T>): Promise<T> => {
    // Append retries stay serialized so backoff cannot invert one lane's arrival order.
    const admission = admissionTail.then(() => withAdmissionClaimLock(work));
    admissionTail = admission.then(
      () => undefined,
      () => undefined,
    );
    return admission;
  };

  return {
    admit: async (
      raw: TRaw,
      admitOptions?: { receivedAt?: number; facts?: ChannelIngressMonitorFacts },
    ) => {
      assertAdmissionOpen();
      const receivedAt = admitOptions?.receivedAt ?? now();
      let durablyAdmitted = false;
      try {
        return await scheduleAdmission(() =>
          admitRaw(raw, {
            receivedAt,
            ...(admitOptions?.facts ? { facts: admitOptions.facts } : {}),
            onDurablyAdmitted: () => {
              durablyAdmitted = true;
            },
          }),
        );
      } finally {
        // A lost transport acknowledgement must not strand an already durable row.
        if (durablyAdmitted) {
          requestDrain();
        }
      }
    },
    admitBatch: async (rawEvents: readonly TRaw[], admitOptions?: { receivedAt?: number }) => {
      assertAdmissionOpen();
      const receivedAt = admitOptions?.receivedAt ?? now();
      let durablyAdmitted = false;
      try {
        return await scheduleAdmission(async () => {
          const results = [];
          for (const raw of rawEvents) {
            results.push(
              await admitRaw(raw, {
                receivedAt,
                onDurablyAdmitted: () => {
                  durablyAdmitted = true;
                },
              }),
            );
          }
          return results;
        });
      } finally {
        if (durablyAdmitted) {
          requestDrain();
        }
      }
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
    requestDrain,
    pause,
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        running = false;
        requested = false;
        clearPollTimer();
        publishActivity();
        // Every transport callback accepted before stop keeps its durable-append guarantee.
        await admissionTail;
        shutdown.abort(createStoppedError());
        await waitForPumpIdle();
        if (options.waitForDeliveryIdleOnStop !== false) {
          await waitForActiveDeliveries();
        }
        // A pump may have created the lazy drain just before observing running=false.
        drain?.dispose();
        if (options.waitForDeliveryIdleOnStop !== false) {
          await drain?.waitForIdle();
        }
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      for (;;) {
        await admissionTail;
        await waitForPumpIdle();
        await waitForActiveDeliveries();
        await drain?.waitForIdle();
        if (!pumping && activeDeliveries.size === 0 && !requested) {
          return;
        }
      }
    },
    waitForPumpIdle,
    isRunning: () => running,
    isStopped: () => stopped,
  };
}
