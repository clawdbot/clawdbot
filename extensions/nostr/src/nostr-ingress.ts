// Nostr plugin module owns durable relay-event admission and replay draining.
import type { Event } from "nostr-tools";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  inspectNostrIngressEvent,
  isNostrIngressRecord,
  migrateNostrLegacyRecentEventIds,
  NOSTR_INGRESS_PAYLOAD_VERSION,
  NostrIngressPermanentError,
  type NostrIngressPayload,
} from "./nostr-ingress-state.js";
import { getNostrRuntime } from "./runtime.js";

const NOSTR_INGRESS_POLL_INTERVAL_MS = 500;
const NOSTR_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const NOSTR_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NOSTR_INGRESS_COMPLETED_MAX_ENTRIES = 100_000;
const NOSTR_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NOSTR_INGRESS_FAILED_MAX_ENTRIES = 100_000;
const NOSTR_INGRESS_APPEND_RETRY_MS = [0, 100, 300] as const;

type PreparedNostrAdmission = {
  event: Event;
  facts: { eventId: string; laneKey: string };
  receivedAt: number;
  payload: NostrIngressPayload;
};

export type NostrIngressLifecycle = Parameters<typeof bindIngressLifecycleToReplyOptions>[0];

type NostrIngressMonitor = {
  ready: () => Promise<void>;
  receive: (event: Event) => Promise<"accepted" | "duplicate">;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export class NostrIngressAdmissionRejectedError extends Error {
  readonly reason: "backpressure" | "oversized-event" | "rate-limited";

  constructor(reason: "backpressure" | "oversized-event" | "rate-limited", message: string) {
    super(message);
    this.name = "NostrIngressAdmissionRejectedError";
    this.reason = reason;
  }
}

function parseClaimedEvent(
  payload: NostrIngressPayload,
  claimedId: string,
  claimedLaneKey: string | undefined,
): Event {
  if (payload.version !== NOSTR_INGRESS_PAYLOAD_VERSION) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} has an unsupported version.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  const facts = inspectNostrIngressEvent(parsed);
  if (
    facts.eventId !== claimedId ||
    facts.laneKey !== claimedLaneKey ||
    !isNostrIngressRecord(parsed)
  ) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} changed event identity.`,
    );
  }
  if (
    typeof parsed.kind !== "number" ||
    typeof parsed.created_at !== "number" ||
    typeof parsed.content !== "string" ||
    typeof parsed.sig !== "string" ||
    !Array.isArray(parsed.tags)
  ) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} has an invalid event shape.`,
    );
  }
  return parsed as Event;
}

export function createNostrIngress(options: {
  accountId: string;
  queue?: ChannelIngressQueue<NostrIngressPayload>;
  legacyEventIds?: readonly string[];
  maxSerializedPayloadBytes: number;
  maxPendingEvents: number;
  maxQueuedAdmissions: number;
  admissionRateLimit: { windowMs: number; maxEvents: number };
  afterDurableAppend: (event: Event) => void;
  deliver: (event: Event, lifecycle: NostrIngressLifecycle) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): NostrIngressMonitor {
  let queue = options.queue;
  let drain!: ChannelIngressDrain;
  let drainInitialized = false;
  let running = true;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;
  let admissionFailure: Error | undefined;
  let admissionWindowStartedAt = Date.now();
  let admissionWindowCount = 0;
  let queuedAdmissions = 0;
  const shutdown = new AbortController();
  const activeDeliveries = new Set<Promise<void>>();

  const getQueue = (): ChannelIngressQueue<NostrIngressPayload> => {
    queue ??= getNostrRuntime().state.openChannelIngressQueue<NostrIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const legacyMigration = migrateNostrLegacyRecentEventIds({
    queue: getQueue(),
    eventIds: options.legacyEventIds ?? [],
  });

  const getDrain = (): ChannelIngressDrain => {
    if (!drainInitialized) {
      drain = createChannelIngressDrain<NostrIngressPayload>({
        queue: getQueue(),
        abortSignal: shutdown.signal,
        adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
        retryPolicy: {
          maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
        },
        resolveNonRetryableFailure: (error) =>
          error instanceof NostrIngressPermanentError
            ? { reason: error.reason, message: error.message }
            : null,
        onLog: (message) => options.onError?.(new Error(message), "ingress drain"),
        dispatchClaimedEvent: async (record, lifecycle) => {
          if (shutdown.signal.aborted || lifecycle.abortSignal.aborted) {
            return {
              kind: "failed-retryable",
              error: new Error("Nostr ingress stopped before dispatch"),
            };
          }
          const event = parseClaimedEvent(record.payload, record.id, record.laneKey);
          let handedOff = false;
          let deferredHandoff = false;
          const delivery = options.deliver(event, {
            ...lifecycle,
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
              await lifecycle.onAbandoned();
            },
          });
          activeDeliveries.add(delivery);
          try {
            await delivery;
            // Policy gates and deliberate no-dispatch turns are terminal.
            if (!handedOff) {
              await lifecycle.onAdopted();
            }
          } finally {
            activeDeliveries.delete(delivery);
          }
          return deferredHandoff ? { kind: "deferred" } : undefined;
        },
      });
      drainInitialized = true;
    }
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < NOSTR_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: NOSTR_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: NOSTR_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: NOSTR_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: NOSTR_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      await legacyMigration;
      for (;;) {
        requested = false;
        await pruneIfDue();
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
      options.onError?.(error as Error, "ingress drain");
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

  const timer = setInterval(requestDrain, options.pollIntervalMs ?? NOSTR_INGRESS_POLL_INTERVAL_MS);
  timer.unref?.();
  requestDrain();

  // Relays may deliver concurrently. Preserve per-pubkey arrival order across append backoff.
  let admissionTail: Promise<void> = Promise.resolve();
  const prepareAdmission = (event: Event): PreparedNostrAdmission => {
    const facts = inspectNostrIngressEvent(event);
    const receivedAt = Date.now();
    if (receivedAt - admissionWindowStartedAt >= options.admissionRateLimit.windowMs) {
      admissionWindowStartedAt = receivedAt;
      admissionWindowCount = 0;
    }
    if (admissionWindowCount >= options.admissionRateLimit.maxEvents) {
      throw new NostrIngressAdmissionRejectedError(
        "rate-limited",
        "Nostr event exceeds the durable admission rate.",
      );
    }
    admissionWindowCount += 1;
    if (queuedAdmissions >= options.maxQueuedAdmissions) {
      throw new NostrIngressAdmissionRejectedError(
        "backpressure",
        "Nostr event exceeds the in-memory admission backlog.",
      );
    }

    let payload: NostrIngressPayload;
    let serializedPayload: string;
    try {
      payload = {
        version: NOSTR_INGRESS_PAYLOAD_VERSION,
        receivedAt,
        rawEvent: JSON.stringify(event),
      };
      serializedPayload = JSON.stringify(payload);
    } catch (error) {
      throw new NostrIngressPermanentError(
        "invalid-event",
        "Nostr event could not be serialized for durable ingress.",
        { cause: error },
      );
    }
    if (Buffer.byteLength(serializedPayload, "utf8") > options.maxSerializedPayloadBytes) {
      throw new NostrIngressAdmissionRejectedError(
        "oversized-event",
        "Nostr event exceeds the durable ingress size limit.",
      );
    }

    return { event, facts, receivedAt, payload };
  };

  const admitOnce = async (prepared: PreparedNostrAdmission): Promise<"accepted" | "duplicate"> => {
    await legacyMigration;
    const pending = await getQueue().listPending({ limit: options.maxPendingEvents });
    const claims = await getQueue().listClaims();
    if (pending.length + claims.length >= options.maxPendingEvents) {
      throw new NostrIngressAdmissionRejectedError(
        "backpressure",
        "Nostr event exceeds the durable ingress backlog.",
      );
    }

    let lastError: unknown;
    for (const delayMs of NOSTR_INGRESS_APPEND_RETRY_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        const result = await getQueue().enqueue(prepared.facts.eventId, prepared.payload, {
          receivedAt: prepared.receivedAt,
          laneKey: prepared.facts.laneKey,
        });
        options.afterDurableAppend(prepared.event);
        requestDrain();
        return result.kind === "accepted" ? "accepted" : "duplicate";
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Nostr durable admission failed: ${formatErrorMessage(lastError)}`, {
      cause: lastError,
    });
  };

  return {
    ready: async () => {
      await legacyMigration;
    },
    receive: (event) => {
      let prepared: PreparedNostrAdmission;
      try {
        prepared = prepareAdmission(event);
      } catch (error) {
        return Promise.reject(error as Error);
      }
      queuedAdmissions += 1;
      const admission = admissionTail.then(async () => {
        if (admissionFailure) {
          throw admissionFailure;
        }
        try {
          return await admitOnce(prepared);
        } catch (error) {
          if (
            error instanceof NostrIngressAdmissionRejectedError ||
            error instanceof NostrIngressPermanentError
          ) {
            throw error;
          }
          admissionFailure =
            error instanceof Error ? error : new Error(formatErrorMessage(error), { cause: error });
          throw admissionFailure;
        }
      });
      const settledAdmission = admission.finally(() => {
        queuedAdmissions -= 1;
      });
      admissionTail = settledAdmission.then(
        () => undefined,
        () => undefined,
      );
      return settledAdmission;
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      await admissionTail;
      shutdown.abort(new Error("Nostr ingress stopped"));
      if (drainInitialized) {
        drain.dispose();
      }
      await pumping;
      if (drainInitialized) {
        drain.dispose();
      }
      await Promise.allSettled(activeDeliveries);
      if (drainInitialized) {
        await drain.waitForIdle();
      }
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
      if (drainInitialized) {
        await drain.waitForIdle();
      }
    },
  };
}
