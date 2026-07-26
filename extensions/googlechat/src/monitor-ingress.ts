// Googlechat plugin module owns raw webhook durable admission and draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { GoogleChatEventPayloadError, parseGoogleChatInboundPayload } from "./monitor-event.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatEvent } from "./types.js";

const GOOGLECHAT_INGRESS_PAYLOAD_VERSION = 1;
const GOOGLECHAT_INGRESS_POLL_INTERVAL_MS = 500;
const GOOGLECHAT_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const GOOGLECHAT_INGRESS_MAX_CONCURRENT_DELIVERIES = 8;
const GOOGLECHAT_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// The webhook retry horizon must fit beneath this cap; match Slack/Mattermost fleet sizing.
// The 30-day TTL is the real horizon, while the cap only bounds disk usage.
const GOOGLECHAT_INGRESS_COMPLETED_MAX_ENTRIES = 20_000;
const GOOGLECHAT_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const GOOGLECHAT_INGRESS_FAILED_MAX_ENTRIES = 20_000;

type GoogleChatIngressPayload = {
  version: 1;
  rawEvent: string;
};

export type GoogleChatIngressLifecycle = Omit<
  ChannelIngressMonitorLifecycle,
  "onAdoptionFinalizing"
>;

type GoogleChatIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type GoogleChatIngressDispatch = (
  event: GoogleChatEvent,
  lifecycle: GoogleChatIngressLifecycle,
) => Promise<GoogleChatIngressDispatchResult | void> | GoogleChatIngressDispatchResult | void;

class GoogleChatIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-event" | "googlechat-auth",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GoogleChatIngressPermanentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new GoogleChatIngressPermanentError(
    "invalid-event",
    `Google Chat MESSAGE event is missing ${field}.`,
  );
}

function inspectGoogleChatIngressEvent(raw: unknown): { eventId: string; laneKey: string } | null {
  if (!isRecord(raw)) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      "Google Chat webhook envelope must be an object.",
    );
  }

  const commonEventObject = isRecord(raw.commonEventObject) ? raw.commonEventObject : null;
  const chat = isRecord(raw.chat) ? raw.chat : null;
  const isAddOn = commonEventObject?.hostApp === "CHAT";
  let eventType: unknown = raw.type ?? raw.eventType;
  let space: Record<string, unknown> | null = isRecord(raw.space) ? raw.space : null;
  let message: Record<string, unknown> | null = isRecord(raw.message) ? raw.message : null;

  if (isAddOn) {
    const messagePayload = isRecord(chat?.messagePayload) ? chat.messagePayload : null;
    if (!messagePayload) {
      // Card clicks and other Add-on actions do not start agent turns.
      return null;
    }
    eventType = "MESSAGE";
    space = isRecord(messagePayload.space) ? messagePayload.space : null;
    message = isRecord(messagePayload.message) ? messagePayload.message : null;
  }

  if (eventType !== "MESSAGE") {
    return null;
  }
  const spaceName = requiredString(space?.name, "space.name");
  const messageName = requiredString(message?.name, "message.name");
  return { eventId: messageName, laneKey: `space:${spaceName}` };
}

function deserializeGoogleChatIngressEvent(rawEvent: string, claimedId: string): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(rawEvent);
  } catch (error) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} contains invalid JSON.`,
      { cause: error },
    );
  }
  return raw;
}

function normalizeClaimedGoogleChatEvent(raw: unknown, claimedId: string): GoogleChatEvent {
  try {
    const parsed = parseGoogleChatInboundPayload(raw);
    const eventType = parsed.event.type ?? parsed.event.eventType;
    if (eventType !== "MESSAGE") {
      throw new GoogleChatEventPayloadError();
    }
    return parsed.event;
  } catch (error) {
    throw new GoogleChatIngressPermanentError(
      "invalid-event",
      `Google Chat ingress row ${claimedId} cannot be normalized.`,
      { cause: error },
    );
  }
}

function resolveGoogleChatIngressNonRetryableFailure(error: unknown) {
  for (const candidate of collectErrorGraphCandidates(error, (current) => [current.cause])) {
    if (candidate instanceof GoogleChatIngressPermanentError) {
      return { reason: candidate.reason, message: candidate.message };
    }
    const message = formatErrorMessage(candidate);
    if (
      /Google Chat API 401\b/.test(message) ||
      /^(?:Missing Google Chat access token|Google Chat (?:credentials|service account)\b|(?:Failed to load|Invalid) Google Chat service account\b)/.test(
        message,
      )
    ) {
      return { reason: "googlechat-auth", message };
    }
  }
  return null;
}

export type GoogleChatIngressMonitor = {
  receive: (
    rawEvent: unknown,
  ) => Promise<{ kind: "durable" | "ignored" } | { kind: "invalid"; message: string }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createGoogleChatIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<GoogleChatIngressPayload>;
  dispatch: GoogleChatIngressDispatch;
  runtime: {
    error?: (message: string) => void;
    log?: (message: string) => void;
  };
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
}): GoogleChatIngressMonitor {
  const serializeForIngress = (rawEvent: unknown): string => {
    if (!isRecord(rawEvent)) {
      throw new GoogleChatIngressPermanentError(
        "invalid-event",
        "Google Chat webhook envelope must be an object.",
      );
    }
    const durableEvent = { ...rawEvent };
    // Authentication is complete before admission; no Add-on authorization token is replay data.
    delete durableEvent.authorizationEventObject;
    const serialized = JSON.stringify(durableEvent);
    if (typeof serialized !== "string") {
      throw new GoogleChatIngressPermanentError(
        "invalid-event",
        "Google Chat webhook envelope cannot be serialized.",
      );
    }
    return serialized;
  };

  const monitor = createChannelIngressMonitor<unknown, string, GoogleChatIngressPayload>({
    queue:
      options.queue ??
      (() =>
        getGoogleChatRuntime().state.openChannelIngressQueue<GoogleChatIngressPayload>({
          accountId: options.accountId,
        })),
    inspect: (rawEvent) => inspectGoogleChatIngressEvent(rawEvent),
    payload: {
      storage: "raw-event",
      version: GOOGLECHAT_INGRESS_PAYLOAD_VERSION,
      serialize: serializeForIngress,
      deserialize: (rawEvent, { claim }) => deserializeGoogleChatIngressEvent(rawEvent, claim.id),
      createClaimError: (kind, claim) =>
        new GoogleChatIngressPermanentError(
          "invalid-event",
          kind === "invalid-version"
            ? `Google Chat ingress row ${claim.id} has an invalid payload.`
            : `Google Chat ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: (rawEvent, lifecycle, claim) =>
      options.dispatch(normalizeClaimedGoogleChatEvent(rawEvent, claim.id), lifecycle),
    pollIntervalMs: options.pollIntervalMs ?? GOOGLECHAT_INGRESS_POLL_INTERVAL_MS,
    retention: {
      pruneIntervalMs: GOOGLECHAT_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: GOOGLECHAT_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: GOOGLECHAT_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: GOOGLECHAT_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: GOOGLECHAT_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      resolveNonRetryableFailure: resolveGoogleChatIngressNonRetryableFailure,
      startLimit: GOOGLECHAT_INGRESS_MAX_CONCURRENT_DELIVERIES,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.error?.(`googlechat: ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    admissionMode: "while-running",
    createStoppedError: () => new Error("Google Chat ingress is stopped."),
    onError: (error) =>
      options.runtime.error?.(`googlechat ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    receive: async (rawEvent) => {
      if (!monitor.isRunning()) {
        throw new Error("Google Chat ingress is stopped.");
      }
      let facts: ReturnType<typeof inspectGoogleChatIngressEvent>;
      try {
        facts = inspectGoogleChatIngressEvent(rawEvent);
      } catch (error) {
        if (error instanceof GoogleChatIngressPermanentError) {
          return { kind: "invalid", message: error.message };
        }
        throw error;
      }
      if (!facts) {
        return { kind: "ignored" };
      }
      await monitor.admit(rawEvent, { facts });
      return { kind: "durable" };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  };
}
