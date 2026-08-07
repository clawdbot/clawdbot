// Matrix plugin module owns raw inbound-event durable ingress and replay draining.
//
// matrix-js-sdk advances the /sync token before events finish dispatching
// (doSync sets the token so a bad event can be skipped), and the persisted
// token then tells the homeserver the batch is consumed. The monitor used to
// dispatch room events into a memory-only detached queue, so a gateway crash
// between the debounced token persist and the end of the agent turn lost the
// message permanently. Every dispatchable event is now journaled into the
// shared channel ingress queue (synchronous SQLite commit) inside the sync
// event listener — before the token persist can land — and replayed through
// the core drain after a restart. The sync store's admission gate backs this
// ordering: its debounced cursor write waits for waitForAdmissions(), so a
// retrying append that holds the admission tail past the debounce can no
// longer let the cursor outrun a still-unjournaled event, and an append
// whose retries exhaust is parked and retried on later drain polls while
// the cursor stays frozen behind it — so a transient SQLite lock recovers
// without a restart, and a genuinely dead journal still redelivers after
// one. Tombstones land only after dispatch adopts or finishes, and the
// persistent inbound deduper skips events already fully handled, so
// redelivery after an unclean shutdown stays exactly-once.
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "../../record-shared.js";
import type { RuntimeEnv } from "../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixRawEvent } from "./types.js";

const MATRIX_INGRESS_PAYLOAD_VERSION = 1;
const MATRIX_INGRESS_POLL_INTERVAL_MS = 1_000;
const MATRIX_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const MATRIX_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MATRIX_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const MATRIX_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MATRIX_INGRESS_FAILED_MAX_ENTRIES = 20_000;

export type MatrixIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
  /**
   * Persisted admission timestamp from the journal payload. Only rows
   * journaled before this monitor started are crash-recovered replays; fresh
   * initial-sync admissions share the same lifecycle shape but must still
   * face the cold-start history filter, so presence of the lifecycle alone
   * cannot mark a replay.
   */
  receivedAt: number;
};

type MatrixIngressPayload = {
  version: 1;
  receivedAt: number;
  roomId: string;
  rawEvent: MatrixRawEvent;
};

type MatrixIngressDispatch = (
  roomId: string,
  event: MatrixRawEvent,
  lifecycle: MatrixIngressLifecycle,
) => Promise<void>;

class MatrixIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MatrixIngressPermanentError";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function inspectMatrixIngressEvent(
  roomId: string,
  rawEvent: unknown,
): { eventId: string; laneKey: string } | null {
  if (!isRecord(rawEvent)) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix inbound event must be an object.",
    );
  }
  // Timeline events always carry event_id; without one the journal cannot
  // dedupe, so the caller keeps the pre-journal live-dispatch path instead of
  // persisting an unidentifiable row.
  const eventId = nonEmptyString(rawEvent.event_id);
  if (!eventId) {
    return null;
  }
  const normalizedRoomId = roomId.trim();
  if (!normalizedRoomId) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix inbound event is missing its room id.",
    );
  }
  return { eventId, laneKey: `room:${normalizedRoomId}` };
}

function parseClaimedEvent(
  payload: unknown,
  claimedId: string,
): { roomId: string; rawEvent: MatrixRawEvent; receivedAt: number } {
  if (!isRecord(payload)) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix ingress payload must be an object.",
    );
  }
  if (payload.version !== MATRIX_INGRESS_PAYLOAD_VERSION) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix ingress payload version is unsupported.",
    );
  }
  const roomId = nonEmptyString(payload.roomId);
  if (!roomId) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix ingress payload is missing its room id.",
    );
  }
  const facts = inspectMatrixIngressEvent(roomId, payload.rawEvent);
  if (!facts || facts.eventId !== claimedId) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix event identity changed after durable admission.",
    );
  }
  if (typeof payload.receivedAt !== "number" || !Number.isFinite(payload.receivedAt)) {
    throw new MatrixIngressPermanentError(
      "invalid-event",
      "Matrix ingress payload is missing its admission timestamp.",
    );
  }
  return { roomId, rawEvent: payload.rawEvent as MatrixRawEvent, receivedAt: payload.receivedAt };
}

function resolveMatrixIngressNonRetryableFailure(error: unknown) {
  if (error instanceof MatrixIngressPermanentError) {
    return { reason: error.reason, message: error.message };
  }
  return null;
}

export type MatrixIngressMonitor = {
  accept: (roomId: string, event: MatrixRawEvent) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
  /**
   * Resolves once every event accepted so far is durably journaled (or has
   * failed loudly). The sync-token store gates its cursor write on this so
   * the persisted token can never advance past an unadmitted event.
   */
  waitForAdmissions: () => Promise<void>;
  /** Permanent journal failure recorded since process start, if any. */
  getAdmissionFailure: () => unknown;
};

export function createMatrixIngressMonitor(options: {
  accountId: string;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: MatrixIngressDispatch;
  /**
   * Events that cannot be journaled (missing event_id) keep the pre-journal
   * live dispatch path; the homeserver redelivers them only while the sync
   * token is unpersisted.
   */
  onUnjournaledEvent: (roomId: string, event: MatrixRawEvent) => void;
  queue?: ChannelIngressQueue<MatrixIngressPayload>;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): MatrixIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const getQueue = (): ChannelIngressQueue<MatrixIngressPayload> => {
    queue ??= getMatrixRuntime().state.openChannelIngressQueue<MatrixIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<MatrixIngressPayload>({
      queue: getQueue(),
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveMatrixIngressNonRetryableFailure,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      onLog: (message) => options.runtime.log?.(`matrix ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        const { roomId, rawEvent, receivedAt } = parseClaimedEvent(record.payload, record.id);
        await options.dispatch(roomId, rawEvent, { ...lifecycle, receivedAt });
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < MATRIX_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: MATRIX_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: MATRIX_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: MATRIX_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: MATRIX_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  // Single-slot idle wake, mirroring the shared core ingress monitor: the
  // pump must not await drain-wide idle, because that serializes unrelated
  // room lanes behind one long turn. Instead the wake re-pumps once the
  // current in-flight claims settle, so same-lane backlog is picked up while
  // other rooms keep dispatching.
  let drainIdleWake: Promise<void> | undefined;
  let drainIdleWakeRequested = false;

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
        const shouldRearm = drainIdleWakeRequested && running;
        drainIdleWake = undefined;
        drainIdleWakeRequested = false;
        if (shouldRearm) {
          scheduleDrainIdleWake(activeDrain);
        }
        if (running) {
          requestDrain();
        }
      },
      (error: unknown) => {
        if (drainIdleWake === wake) {
          drainIdleWake = undefined;
          drainIdleWakeRequested = false;
        }
        options.runtime.error?.(`matrix ingress idle wake failed: ${formatErrorMessage(error)}`);
      },
    );
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() may have run during the async prune; creating the lazy drain
        // now would leave an undisposed instance dispatching after stop.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        if (started > 0) {
          scheduleDrainIdleWake(activeDrain);
        }
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`matrix ingress drain failed: ${formatErrorMessage(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    scheduleAdmissionRetry();
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  // Serialize admissions so a retry-backed-off append cannot invert room
  // arrival order in the queue (order over latency).
  let admissionTail: Promise<void> = Promise.resolve();
  // A journal append that exhausts its live retries is parked here and
  // retried on later drain polls until it lands. While any admission stays
  // parked the sync-token store refuses to advance the durable cursor past
  // it, so the event is never skipped — and the cursor unfreezes as soon as
  // the journal append succeeds again instead of needing a restart. Later
  // accepts queue behind the parked tail without touching the journal, so
  // queue rows always land in accept order.
  const parkedAdmissions: Array<{
    roomId: string;
    event: MatrixRawEvent;
    facts: { eventId: string; laneKey: string };
    receivedAt: number;
  }> = [];
  let admissionFailure: unknown = null;

  const journalEvent = async (admission: {
    roomId: string;
    event: MatrixRawEvent;
    facts: { eventId: string; laneKey: string };
    receivedAt: number;
  }): Promise<void> => {
    await getQueue().enqueue(
      admission.facts.eventId,
      {
        version: MATRIX_INGRESS_PAYLOAD_VERSION,
        receivedAt: admission.receivedAt,
        roomId: admission.roomId.trim(),
        rawEvent: admission.event,
      },
      { receivedAt: admission.receivedAt, laneKey: admission.facts.laneKey },
    );
  };

  // Single attempts only: the live retry budget already ran for these rows.
  // Stop at the first failure so room arrival order cannot invert.
  const retryParkedAdmissions = async (): Promise<void> => {
    for (;;) {
      const next = parkedAdmissions[0];
      if (!next) {
        admissionFailure = null;
        requestDrain();
        return;
      }
      try {
        await journalEvent(next);
        parkedAdmissions.shift();
      } catch (error) {
        admissionFailure = error;
        return;
      }
    }
  };

  // The drain poll timer drives recovery while the cursor stays frozen, so a
  // transient SQLite lock no longer turns into a process-lifetime block.
  let admissionRetryScheduled = false;
  const scheduleAdmissionRetry = (): void => {
    if (admissionRetryScheduled || parkedAdmissions.length === 0) {
      return;
    }
    admissionRetryScheduled = true;
    const retry = admissionTail.then(async () => {
      try {
        await retryParkedAdmissions();
      } finally {
        admissionRetryScheduled = false;
      }
    });
    admissionTail = retry.catch(() => undefined);
  };

  const admitOnce = async (roomId: string, event: MatrixRawEvent): Promise<void> => {
    const facts = inspectMatrixIngressEvent(roomId, event);
    if (!facts) {
      options.onUnjournaledEvent(roomId, event);
      return;
    }
    // The journal shares the state DB with the sync-token store: a dropped
    // append means the token persist fails too, so the homeserver redelivers
    // after restart. Retry transient failures, then park for poll-driven
    // retries rather than dispatching live around the drain's dedupe and
    // lane serialization.
    const admission = { roomId, event, facts, receivedAt: Date.now() };
    // A still-parked predecessor must enter the journal first. Appending
    // this newer event now could succeed while the older one is parked, and
    // the drain would dispatch the room out of accept order — the queue can
    // only order persisted rows. Queue behind the parked tail; the
    // poll-driven retry lands both in order.
    if (parkedAdmissions.length > 0) {
      parkedAdmissions.push(admission);
      scheduleAdmissionRetry();
      return;
    }
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await journalEvent(admission);
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    options.runtime.error?.(
      `matrix ingress: failed to durably journal inbound event room=${roomId} id=${facts.eventId}: ${formatErrorMessage(lastError)}`,
    );
    parkedAdmissions.push(admission);
    admissionFailure = lastError;
    scheduleAdmissionRetry();
  };

  return {
    accept: (roomId, event) => {
      // Parked retries run first, and admitOnce itself queues behind any
      // still-parked predecessor, so journal order always matches accept
      // order even while the queue keeps failing.
      const admission = admissionTail
        .then(() => retryParkedAdmissions())
        .then(() => admitOnce(roomId, event));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
    waitForAdmissions: async () => {
      // Settle-stable: an admission chained during the wait reassigns the
      // tail, so only an unchanged tail proves nothing is still in flight.
      // The sync cursor persist depends on that proof — awaiting a stale
      // tail would let the cursor outrun the newly chained event.
      for (;;) {
        const tail = admissionTail;
        await tail;
        if (tail === admissionTail) {
          return;
        }
      }
    },
    getAdmissionFailure: () => admissionFailure,
    start: () => {
      if (running) {
        return;
      }
      running = true;
      requestDrain();
      pollTimer = setInterval(
        requestDrain,
        options.pollIntervalMs ?? MATRIX_INGRESS_POLL_INTERVAL_MS,
      );
      pollTimer.unref?.();
    },
    stop: async () => {
      running = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      // A caller returning from stop() must know every accepted event is
      // durably committed; an in-flight admission racing process exit would
      // otherwise lose the message.
      await admissionTail;
      // Snapshot in-flight dispatch tasks before dispose() clears the drain's
      // registry: the abort settles them through the normal task path, and
      // stop() must not return while an aborted turn is still unwinding.
      const inFlight = drain?.waitForIdle();
      drain?.dispose();
      await pumping;
      // The pump may have lazily created the drain after the first dispose.
      drain?.dispose();
      await inFlight;
      await drain?.waitForIdle();
    },
    waitForIdle: async () => {
      for (;;) {
        const activePump = pumping;
        if (activePump) {
          await activePump;
          continue;
        }
        await drain?.waitForIdle();
        // An idle wake can re-arm the pump right as deliveries settle; loop
        // once more so callers observe a truly quiescent monitor.
        if (!pumping) {
          return;
        }
      }
    },
  };
}
