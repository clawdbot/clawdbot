// Synology Chat plugin owns raw webhook durable admission and draining.
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressError,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getSynologyRuntime } from "./runtime.js";

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

export const SynologyIngressPermanentError = createChannelIngressError<
  "invalid-event" | "synology-auth"
>("SynologyIngressPermanentError", { withReason: true });
export type SynologyIngressPermanentError = InstanceType<typeof SynologyIngressPermanentError>;

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
}) {
  const serializeForIngress = (rawEvent: SynologyWebhookRawEvent): string => {
    const bodyFields = { ...rawEvent.bodyFields };
    const queryFields = { ...rawEvent.queryFields };
    // Authentication is complete before admission; tokens are not replay data.
    delete bodyFields.token;
    delete queryFields.token;
    return JSON.stringify({ bodyFields, queryFields });
  };

  return createStandardRawEventIngressMonitor({
    queue:
      options.queue ??
      (() =>
        getSynologyRuntime().state.openChannelIngressQueue<SynologyIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (rawEvent) => inspectSynologyIngressEvent(rawEvent),
    payload: {
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
    pollIntervalMs: options.pollIntervalMs,
    // Synology has no published retry horizon; keep the conservative 30-day / 20k cap.
    drain: {
      resolveNonRetryableFailure: resolveSynologyIngressNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.error?.(`synology-chat: ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Synology Chat ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(`synology-chat ingress drain failed: ${formatErrorMessage(error)}`),
    classifyAdmissionError: (error) =>
      error instanceof SynologyIngressPermanentError ? error.message : undefined,
  });
}

export type SynologyIngressMonitor = ReturnType<typeof createSynologyIngressMonitor>;
