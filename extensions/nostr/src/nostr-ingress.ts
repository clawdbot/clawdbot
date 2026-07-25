// Nostr plugin module owns durable relay-event admission and replay draining.
import type { Event } from "nostr-tools";
import {
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  type ChannelIngressMonitorLifecycle,
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

export type NostrIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

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

function deserializeNostrIngressEvent(rawEvent: string, claimedId: string): Event {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (!isNostrIngressRecord(parsed)) {
    throw new NostrIngressPermanentError(
      "invalid-event",
      `Nostr ingress row ${claimedId} has an invalid event shape.`,
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
  let admissionFailure: Error | undefined;
  let admissionWindowStartedAt = Date.now();
  let admissionWindowCount = 0;
  let queuedAdmissions = 0;
  let stopping = false;
  let stopTask: Promise<void> | undefined;

  const createStoppedError = () => new Error("Nostr ingress stopped");

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

  const monitor = createChannelIngressMonitor<
    Event,
    { receivedAt: number; rawEvent: string },
    NostrIngressPayload
  >({
    queue: getQueue,
    inspect: (event) => {
      const facts = inspectNostrIngressEvent(event);
      return { eventId: facts.eventId, laneKey: facts.laneKey };
    },
    payload: {
      version: NOSTR_INGRESS_PAYLOAD_VERSION,
      serialize: (event, { receivedAt }) => ({
        receivedAt,
        rawEvent: JSON.stringify(event),
      }),
      deserialize: (body, { claim }) => deserializeNostrIngressEvent(body.rawEvent, claim.id),
      encode: ({ body }) => ({ version: NOSTR_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => {
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof payload.rawEvent !== "string"
        ) {
          throw new NostrIngressPermanentError(
            "invalid-event",
            `Nostr ingress row ${claim.id} has an invalid payload.`,
          );
        }
        return {
          version: payload.version,
          body: {
            receivedAt: typeof payload.receivedAt === "number" ? payload.receivedAt : 0,
            rawEvent: payload.rawEvent,
          },
        };
      },
      createClaimError: (kind, claim) =>
        new NostrIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Nostr ingress row ${claim.id} has an unsupported version.`
            : `Nostr ingress row ${claim.id} changed event identity.`,
        ),
    },
    deliver: (event, lifecycle) => options.deliver(event, lifecycle),
    pollIntervalMs: options.pollIntervalMs ?? NOSTR_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: NOSTR_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: NOSTR_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: NOSTR_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: NOSTR_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: NOSTR_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      resolveNonRetryableFailure: (error) =>
        error instanceof NostrIngressPermanentError
          ? { reason: error.reason, message: error.message }
          : null,
      onLog: (message) => options.onError?.(new Error(message), "ingress drain"),
    },
    createStoppedError,
    onError: (error) => options.onError?.(error as Error, "ingress drain"),
  });
  const monitorStart = legacyMigration.then(() => {
    // stop() may run while the legacy migration is pending. Do not let that
    // deferred startup revive polling after shutdown has begun.
    if (!stopping) {
      monitor.start();
    }
  });
  void monitorStart.catch((error: unknown) => options.onError?.(error as Error, "ingress drain"));

  // Admission stays local because relay ack needs accepted/duplicate plus rate,
  // size, backlog, cursor, and failure-latch semantics the shared monitor hides.
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
        monitor.requestDrain();
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
      await monitorStart;
    },
    receive: (event) => {
      if (stopping) {
        return Promise.reject(createStoppedError());
      }
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
    stop: () => {
      if (stopTask) {
        return stopTask;
      }
      stopping = true;
      // pause() closes the polling gate synchronously before waiting for local
      // admissions that still retain Nostr's relay acknowledgement contract.
      const pauseTask = monitor.pause();
      stopTask = (async () => {
        await admissionTail;
        await monitorStart.catch(() => undefined);
        await pauseTask;
        await monitor.stop();
      })();
      return stopTask;
    },
    waitForIdle: async () => {
      await admissionTail;
      await monitorStart;
      await monitor.waitForIdle();
    },
  };
}
