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
// the core drain after a restart. Tombstones land only after dispatch adopts
// or finishes, and the persistent inbound deduper skips events already fully
// handled, so redelivery after an unclean shutdown stays exactly-once.
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
): { roomId: string; rawEvent: MatrixRawEvent } {
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
  return { roomId, rawEvent: payload.rawEvent as MatrixRawEvent };
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
        const { roomId, rawEvent } = parseClaimedEvent(record.payload, record.id);
        await options.dispatch(roomId, rawEvent, lifecycle);
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
        await activeDrain.waitForIdle();
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
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  // Serialize admissions so a retry-backed-off append cannot invert room
  // arrival order in the queue (order over latency).
  let admissionTail: Promise<void> = Promise.resolve();

  const admitOnce = async (roomId: string, event: MatrixRawEvent): Promise<void> => {
    const facts = inspectMatrixIngressEvent(roomId, event);
    if (!facts) {
      options.onUnjournaledEvent(roomId, event);
      return;
    }
    const receivedAt = Date.now();
    // The journal shares the state DB with the sync-token store: a dropped
    // append means the token persist fails too, so the homeserver redelivers
    // after restart. Retry transient failures, then drop loudly rather than
    // dispatching live around the drain's dedupe and lane serialization.
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          facts.eventId,
          {
            version: MATRIX_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            roomId: roomId.trim(),
            rawEvent: event,
          },
          { receivedAt, laneKey: facts.laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    options.runtime.error?.(
      `matrix ingress: failed to durably journal inbound event room=${roomId} id=${facts.eventId}: ${formatErrorMessage(lastError)}`,
    );
  };

  return {
    accept: (roomId, event) => {
      const admission = admissionTail.then(() => admitOnce(roomId, event));
      admissionTail = admission.catch(() => undefined);
      return admission;
    },
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
      drain?.dispose();
      await pumping;
      // The pump may have lazily created the drain after the first dispose.
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
