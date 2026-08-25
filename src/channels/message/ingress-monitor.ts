/** Shared durable channel-ingress admission, pump, retention, and shutdown lifecycle. */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { isGatewayRestartDraining } from "../../process/gateway-work-admission.js";
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
import { ChannelIngressUnavailableError } from "./ingress-unavailable.js";

const DEFAULT_APPEND_RETRY_DELAYS_MS = [0, 100, 300] as const;

/** Stable identity and serialization lane extracted before durable admission. */
export type ChannelIngressMonitorFacts = { eventId: string; laneKey: string };

/** Versioned body presented to a channel's persisted-payload encoder. */
type ChannelIngressPayloadEnvelope<TBody> = { version: number; body: TBody };

/** Claim ownership lifecycle handed to one channel delivery. */
export type ChannelIngressMonitorLifecycle = {
  admission: "exclusive";
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onDeferredHeartbeat?: () => void;
  onAdoptionFinalizing: () => void;
  onFailed?: (error: unknown) => void | Promise<void>;
  onCancelled?: () => void | Promise<void>;
  onAbandoned: () => void | Promise<void>;
};

/** Optional explicit outcome from a channel delivery. */
export type ChannelIngressMonitorDeliveryResult<TCompletedMetadata = unknown> =
  | { kind: "completed"; metadata?: TCompletedMetadata }
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

export type ChannelIngressMonitorPayloadCodec<TRaw, TBody, TStoredPayload, TMetadata> = {
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

/** Replay-guard retention defaults; changing a value requires a per-channel keyspace audit. */
export const CHANNEL_INGRESS_RETENTION_DEFAULTS = Object.freeze({
  pruneIntervalMs: 60 * 60 * 1_000,
  completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  completedMaxEntries: 20_000,
  failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
  failedMaxEntries: 20_000,
} satisfies ChannelIngressMonitorRetention);

export type ChannelIngressMonitorDrainOptions<TStoredPayload, TMetadata> = Omit<
  CreateChannelIngressDrainOptions<TStoredPayload, TMetadata>,
  "queue" | "dispatchClaimedEvent" | "abortSignal" | "now" | "ownerId" | "claimLeaseMs"
>;

// prettier-ignore
export type CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata = unknown, TCompletedMetadata = unknown> = {
  queue:
    | ChannelIngressQueue<TStoredPayload, TMetadata, TCompletedMetadata>
    | (() => ChannelIngressQueue<TStoredPayload, TMetadata, TCompletedMetadata>);
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
    | Promise<ChannelIngressMonitorDeliveryResult<TCompletedMetadata> | void>
    | ChannelIngressMonitorDeliveryResult<TCompletedMetadata>
    | void;
  pollIntervalMs: number;
  retention: "standard" | Partial<ChannelIngressMonitorRetention>;
  appendRetryDelaysMs?: readonly number[];
  /**
   * Runs after every durable enqueue. `isNew` means this admission inserted the queue
   * row; a pruned event can become new again. It does not imply claim or delivery.
   */
  onDurableAdmission?: (
    raw: TRaw,
    context: { facts: ChannelIngressMonitorFacts; receivedAt: number; isNew: boolean },
  ) => void | Promise<void>;
  onAdmissionFailure?: (raw: TRaw, error: unknown) => void | Promise<void>;
  /** False lets repeated requests fill drain capacity while earlier claims remain active. */
  waitForDeliveryIdleBeforeRepump?: boolean;
  /** Runs each pump under a channel-owned async context such as a detached request root. */
  runPumpTask?: (work: () => Promise<void>) => Promise<void>;
  /** False lets a channel apply its own bounded delivery grace before final disposal. */
  waitForDeliveryIdleOnStop?: boolean;
  /** Tracks deferred reply ownership through stop, abort, or an explicit channel-owned wait. */
  deferredClaims?: "wait-on-stop" | "settle-on-abort" | "manual";
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
// prettier-ignore
export function createChannelIngressMonitor<TRaw, TBody, TStoredPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
  options: CreateChannelIngressMonitorOptions<TRaw, TBody, TStoredPayload, TMetadata, TCompletedMetadata>,
) {
  const now = options.now ?? Date.now;
  const waitForDeliveryIdleBeforeRepump = options.waitForDeliveryIdleBeforeRepump ?? false;
  const retention =
    options.retention === "standard"
      ? CHANNEL_INGRESS_RETENTION_DEFAULTS
      : { ...CHANNEL_INGRESS_RETENTION_DEFAULTS, ...options.retention };
  const { pruneIntervalMs, ...pruneOptions } = retention;
  const shutdown = new AbortController();
  const drainAbortSignal = options.abortSignal
    ? AbortSignal.any([shutdown.signal, options.abortSignal])
    : shutdown.signal;
  const activeDeliveries = new Set<Promise<unknown>>();
  const deferredClaims = new Set<Promise<void>>();
  type Queue = ChannelIngressQueue<TStoredPayload, TMetadata, TCompletedMetadata>;
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

  const ensureQueueAvailable = (): void => {
    try {
      getQueue();
    } catch (error) {
      throw new ChannelIngressUnavailableError(
        `Channel ingress queue is unavailable: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
  };

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

  const waitForDeferredClaims = async (): Promise<void> => {
    while (deferredClaims.size > 0) {
      await Promise.allSettled(deferredClaims.values());
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
        let resolveDeferredClaim = () => {};
        const deferredClaim = options.deferredClaims
          ? new Promise<void>((resolve) => {
              resolveDeferredClaim = resolve;
            })
          : undefined;
        let deferredClaimSettled = false;
        const settleDeferredClaim = () => {
          if (!deferredClaim || deferredClaimSettled) {
            return;
          }
          deferredClaimSettled = true;
          lifecycle.abortSignal.removeEventListener("abort", settleDeferredClaim);
          deferredClaims.delete(deferredClaim);
          resolveDeferredClaim();
        };
        if (options.deferredClaims === "settle-on-abort") {
          lifecycle.abortSignal.addEventListener("abort", settleDeferredClaim, { once: true });
          if (lifecycle.abortSignal.aborted) {
            settleDeferredClaim();
          }
        }
        const settleDeferredLifecycle = async (settle: () => void | Promise<void>) => {
          handedOff = true;
          deferredHandoff = true;
          try {
            await settle();
            requestDrain();
          } finally {
            settleDeferredClaim();
          }
        };
        const wrappedLifecycle: ChannelIngressMonitorLifecycle = {
          ...lifecycle,
          admission: "exclusive",
          onAdopted: async () => {
            handedOff = true;
            try {
              await lifecycle.onAdopted();
              requestDrain();
            } finally {
              settleDeferredClaim();
            }
          },
          onDeferred: () => {
            handedOff = true;
            deferredHandoff = true;
            if (deferredClaim && !deferredClaimSettled) {
              deferredClaims.add(deferredClaim);
            }
            lifecycle.onDeferred();
          },
          onAdoptionFinalizing: () => {
            handedOff = true;
            deferredHandoff = true;
            lifecycle.onAdoptionFinalizing();
          },
          onFailed: (error) => settleDeferredLifecycle(() => lifecycle.onFailed?.(error)),
          onCancelled: () => settleDeferredLifecycle(() => lifecycle.onCancelled?.()),
          onAbandoned: () => settleDeferredLifecycle(() => lifecycle.onAbandoned()),
        };

        // Adoption can complete before delivery returns; track both lifetimes so stop
        // never drops channel work merely because the durable claim already settled.
        const delivery = Promise.resolve().then(() =>
          options.deliver(raw, wrappedLifecycle, claim),
        );
        activeDeliveries.add(delivery);
        publishActivity();
        let result: ChannelIngressMonitorDeliveryResult<TCompletedMetadata> | void;
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
        // Terminal and handoff outcomes must reach the drain even when stop
        // races the return: the drain settles terminal results under abort and
        // keeps deferred claims for their owner. Rewriting them to
        // failed-retryable here would release claims whose side effects already
        // ran, replaying delivered work on restart.
        if (result?.kind === "completed") {
          // A deferred handoff recorded during delivery stays authoritative:
          // the drain already placed the claim in deferred and only settles a
          // completed result from dispatching, so a conflicting terminal return
          // would strand the claim until later recovery.
          if (deferredHandoff) {
            return { kind: "deferred" };
          }
          return result;
        }
        if (result?.kind === "deferred") {
          if (!deferredHandoff) {
            wrappedLifecycle.onDeferred();
          }
          return { kind: "deferred" };
        }
        if (deferredHandoff) {
          return { kind: "deferred" };
        }
        if (isAborted() || lifecycle.abortSignal.aborted) {
          return { kind: "failed-retryable", error: createStoppedError() };
        }
        if (!handedOff) {
          // A policy gate or deliberate no-dispatch is terminal for transport replay.
          await wrappedLifecycle.onAdopted();
        }
        return { kind: "completed" };
      },
    });
    return drain;
  };

  const pruneIfDue = async (owner: "admission" | "pump"): Promise<void> => {
    // Zero preserves admission-owned compatibility: prune once per admission, never from a pump.
    if ((owner === "admission") !== pruneIntervalMs <= 0) {
      return;
    }
    const currentTime = now();
    if (owner === "pump" && currentTime - lastPrunedAt < pruneIntervalMs) {
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
        await pruneIfDue("pump");
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
    if (!running || isAborted() || isGatewayRestartDraining()) {
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
    for (const delayMs of options.appendRetryDelaysMs ?? DEFAULT_APPEND_RETRY_DELAYS_MS) {
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
      pruneTask?: Promise<void>;
    },
  ) => {
    try {
      const facts = admitOptions.facts ?? options.inspect(raw, { phase: "admission" });
      if (!facts) {
        return { kind: "ignored" } as const;
      }
      admitOptions.pruneTask ??= pruneIfDue("admission");
      await admitOptions.pruneTask;
      const { receivedAt } = admitOptions;
      const body = options.payload.serialize(raw, { facts, receivedAt });
      const payload =
        options.payload.storage === "raw-event"
          ? ({ version: options.payload.version, rawEvent: body } as TStoredPayload)
          : options.payload.encode({ version: options.payload.version, body });
      const queueResult = await admitOnce({ facts, payload, receivedAt });
      admitOptions.onDurablyAdmitted();
      await options.onDurableAdmission?.(raw, {
        facts,
        receivedAt,
        isNew: queueResult.kind === "accepted",
      });
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
      const sharedOptions = {
        receivedAt,
        onDurablyAdmitted: () => {
          durablyAdmitted = true;
        },
      };
      try {
        return await scheduleAdmission(async () => {
          const results = [];
          for (const raw of rawEvents) {
            results.push(await admitRaw(raw, sharedOptions));
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
      // Open the durable queue before arming the poll timer. A monitor without a queue can
      // neither admit nor drain, so channel start must fail through the caller instead of
      // running a timer that reports the same unrecoverable error on every tick. The typed
      // rethrow is what lets the gateway record the failure as dead ingress rather than as
      // one more anonymous channel crash.
      ensureQueueAvailable();
      running = true;
      pollTimer = setInterval(requestDrain, options.pollIntervalMs);
      pollTimer.unref?.();
      requestDrain();
    },
    ensureQueueAvailable,
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
        if (options.deferredClaims && options.deferredClaims !== "manual") {
          await waitForDeferredClaims();
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
    waitForDeferredClaims,
    waitForPumpIdle,
    isRunning: () => running,
    isStopped: () => stopped,
  };
}
