// Synology Chat plugin owns raw webhook durable admission and draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getSynologyRuntime } from "./runtime.js";

const SYNOLOGY_INGRESS_PAYLOAD_VERSION = 1;
const SYNOLOGY_INGRESS_POLL_INTERVAL_MS = 500;
const SYNOLOGY_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const SYNOLOGY_INGRESS_MAX_CONCURRENT_DELIVERIES = 8;
const SYNOLOGY_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// Synology does not publish a webhook retry horizon. Keep the fleet's conservative
// webhook cap so any duplicate POST retains its post_id tombstone.
const SYNOLOGY_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const SYNOLOGY_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SYNOLOGY_INGRESS_FAILED_MAX_ENTRIES = 20_000;

export type SynologyWebhookRawEvent = {
  bodyFields: Record<string, unknown>;
  queryFields: Record<string, unknown>;
};

type SynologyIngressPayload = {
  version: 1;
  rawEvent: string;
};

export type SynologyIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "onAdoptionFinalizing">;

type SynologyIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type SynologyIngressDispatch = (
  event: SynologyWebhookRawEvent,
  lifecycle: SynologyIngressLifecycle,
) => Promise<SynologyIngressDispatchResult | void> | SynologyIngressDispatchResult | void;

export class SynologyIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "synology-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SynologyIngressPermanentError";
  }
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = firstNonEmptyString(item);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function pickRawField(event: SynologyWebhookRawEvent, field: string): string | undefined {
  return (
    firstNonEmptyString(event.bodyFields[field]) ?? firstNonEmptyString(event.queryFields[field])
  );
}

function inspectSynologyIngressEvent(event: SynologyWebhookRawEvent): {
  eventId: string;
  laneKey: string;
} {
  const eventId = pickRawField(event, "post_id");
  if (!eventId) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      "Synology Chat webhook is missing post_id.",
    );
  }
  const userId =
    pickRawField(event, "user_id") ?? pickRawField(event, "userId") ?? pickRawField(event, "user");
  if (!userId) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      "Synology Chat webhook is missing user_id.",
    );
  }
  const channelId = pickRawField(event, "channel_id");
  return {
    eventId,
    laneKey: channelId ? `channel:${channelId}` : `direct:${userId}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deserializeSynologyIngressEvent(
  rawEvent: string,
  claimedId: string,
): SynologyWebhookRawEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.bodyFields) || !isRecord(parsed.queryFields)) {
    throw new SynologyIngressPermanentError(
      "invalid-event",
      `Synology Chat ingress row ${claimedId} has an invalid webhook envelope.`,
    );
  }
  return {
    bodyFields: parsed.bodyFields,
    queryFields: parsed.queryFields,
  };
}

function resolveSynologyIngressNonRetryableFailure(error: unknown) {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (candidate instanceof SynologyIngressPermanentError) {
      return { reason: candidate.reason, message: candidate.message };
    }
  }
  return null;
}

export type SynologyIngressMonitor = {
  receive: (
    rawEvent: SynologyWebhookRawEvent,
  ) => Promise<{ kind: "durable" } | { kind: "invalid"; message: string }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createSynologyIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<SynologyIngressPayload>;
  dispatch: SynologyIngressDispatch;
  runtime: {
    error?: (message: string) => void;
  };
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): SynologyIngressMonitor {
  const serializeForIngress = (rawEvent: SynologyWebhookRawEvent): string => {
    const bodyFields = { ...rawEvent.bodyFields };
    const queryFields = { ...rawEvent.queryFields };
    // Authentication is complete before admission; tokens are not replay data.
    delete bodyFields.token;
    delete queryFields.token;
    return JSON.stringify({ bodyFields, queryFields });
  };

  const monitor = createChannelIngressMonitor<
    SynologyWebhookRawEvent,
    string,
    SynologyIngressPayload
  >({
    queue:
      options.queue ??
      (() =>
        getSynologyRuntime().state.openChannelIngressQueue<SynologyIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (rawEvent) => inspectSynologyIngressEvent(rawEvent),
    payload: {
      storage: "raw-event",
      version: SYNOLOGY_INGRESS_PAYLOAD_VERSION,
      serialize: serializeForIngress,
      deserialize: (rawEvent, { claim }) => deserializeSynologyIngressEvent(rawEvent, claim.id),
      createClaimError: (kind, claim) =>
        new SynologyIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Synology Chat ingress row ${claim.id} has an invalid payload.`
            : `Synology Chat ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: (rawEvent, lifecycle) => options.dispatch(rawEvent, lifecycle),
    pollIntervalMs: options.pollIntervalMs ?? SYNOLOGY_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: SYNOLOGY_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: SYNOLOGY_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: SYNOLOGY_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: SYNOLOGY_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: SYNOLOGY_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      resolveNonRetryableFailure: resolveSynologyIngressNonRetryableFailure,
      startLimit: SYNOLOGY_INGRESS_MAX_CONCURRENT_DELIVERIES,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.error?.(`synology-chat: ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    admissionMode: "while-running",
    createStoppedError: () => new Error("Synology Chat ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(`synology-chat ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    receive: async (rawEvent) => {
      if (!monitor.isRunning()) {
        throw new Error("Synology Chat ingress is stopped.");
      }
      let facts: ReturnType<typeof inspectSynologyIngressEvent>;
      try {
        facts = inspectSynologyIngressEvent(rawEvent);
      } catch (error) {
        if (error instanceof SynologyIngressPermanentError) {
          return { kind: "invalid", message: error.message };
        }
        throw error;
      }
      await monitor.admit(rawEvent, { facts });
      return { kind: "durable" };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
