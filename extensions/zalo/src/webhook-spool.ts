// Zalo plugin owns raw webhook durable admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeNullableString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { ZaloApiError, type ZaloUpdate } from "./api.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { getZaloRuntime } from "./runtime.js";

const ZALO_WEBHOOK_SPOOL_VERSION = 1;
const ZALO_WEBHOOK_DRAIN_INTERVAL_MS = 500;
const ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES = 8;

type ZaloWebhookSpoolPayload = {
  version: 1;
  rawEvent: string;
};

export type ZaloWebhookIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export const ZaloWebhookPayloadError = createChannelIngressError("ZaloWebhookPayloadError");
export type ZaloWebhookPayloadError = InstanceType<typeof ZaloWebhookPayloadError>;

type ZaloWebhookIngress = {
  accept: (rawEvent: string) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

function parseRawRecord(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new ZaloWebhookPayloadError("Zalo webhook body contains invalid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ZaloWebhookPayloadError("Zalo webhook body must be a JSON object.");
  }
  return parsed;
}

function resolveUpdateRecord(envelope: Record<string, unknown>): Record<string, unknown> {
  // Preserve the accepted direct and legacy { ok, result } envelope shapes.
  if (envelope.ok === true && isRecord(envelope.result)) {
    return envelope.result;
  }
  return envelope;
}

function inspectZaloWebhookEvent(rawEvent: string): {
  eventId: string;
  laneKey: string;
  update: Record<string, unknown>;
} {
  const update = resolveUpdateRecord(parseRawRecord(rawEvent));
  const message = isRecord(update.message) ? update.message : null;
  const eventId = nonEmptyString(message?.message_id);
  if (!eventId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
  }
  const chat = isRecord(message?.chat) ? message.chat : null;
  const chatId = nonEmptyString(chat?.id);
  if (!chatId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
  }
  return { eventId, laneKey: `chat:${chatId}`, update };
}

function parseClaimedUpdate(payload: ZaloWebhookSpoolPayload, claimedId: string): ZaloUpdate {
  if (payload.version !== ZALO_WEBHOOK_SPOOL_VERSION || typeof payload.rawEvent !== "string") {
    throw new ZaloWebhookPayloadError("Zalo webhook spool payload is invalid.");
  }
  const facts = inspectZaloWebhookEvent(payload.rawEvent);
  if (facts.eventId !== claimedId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message id changed after durable admission.");
  }
  const eventName = nonEmptyString(facts.update.event_name);
  if (
    eventName !== "message.text.received" &&
    eventName !== "message.image.received" &&
    eventName !== "message.sticker.received" &&
    eventName !== "message.unsupported.received"
  ) {
    throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
  }
  const message = facts.update.message as Record<string, unknown>;
  const from = isRecord(message.from) ? message.from : null;
  const chat = isRecord(message.chat) ? message.chat : null;
  const fromId = nonEmptyString(from?.id);
  if (!from || !fromId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.from.id.");
  }
  const chatId = nonEmptyString(chat?.id);
  if (!chatId) {
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
  }
  if (chat?.chat_type !== "PRIVATE" && chat?.chat_type !== "GROUP") {
    throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid chat type.");
  }
  if (typeof message.date !== "number" || !Number.isFinite(message.date)) {
    throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid date.");
  }
  if (eventName === "message.text.received" && typeof message.text !== "string") {
    throw new ZaloWebhookPayloadError("Zalo text event is missing message.text.");
  }
  return {
    event_name: eventName,
    message: {
      message_id: claimedId,
      from: {
        id: fromId,
        ...(typeof from.name === "string" ? { name: from.name } : {}),
        ...(typeof from.display_name === "string" ? { display_name: from.display_name } : {}),
        ...(typeof from.avatar === "string" ? { avatar: from.avatar } : {}),
        ...(typeof from.is_bot === "boolean" ? { is_bot: from.is_bot } : {}),
      },
      chat: {
        id: chatId,
        chat_type: chat.chat_type,
      },
      date: message.date,
      ...(typeof message.text === "string" ? { text: message.text } : {}),
      ...(typeof message.photo_url === "string" ? { photo_url: message.photo_url } : {}),
      ...(typeof message.caption === "string" ? { caption: message.caption } : {}),
      ...(typeof message.sticker === "string" ? { sticker: message.sticker } : {}),
      ...(typeof message.message_type === "string" ? { message_type: message.message_type } : {}),
    },
  };
}

function isZaloAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      errorCode?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    if (
      (current instanceof ZaloApiError &&
        (current.errorCode === 401 || current.errorCode === 403)) ||
      candidate.status === 401 ||
      candidate.status === 403 ||
      candidate.statusCode === 401 ||
      candidate.statusCode === 403
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function createZaloWebhookIngress(options: {
  accountId: string;
  runtime: Pick<ZaloRuntimeEnv, "error" | "log">;
  deliver: (update: ZaloUpdate, lifecycle: ZaloWebhookIngressLifecycle) => Promise<void>;
  queue?: ChannelIngressQueue<ZaloWebhookSpoolPayload>;
}): ZaloWebhookIngress {
  const queue =
    options.queue ??
    getZaloRuntime().state.openChannelIngressQueue<ZaloWebhookSpoolPayload>({
      accountId: options.accountId,
    });
  const monitor = createChannelIngressMonitor<string, string, ZaloWebhookSpoolPayload>({
    queue,
    inspect: (rawEvent) => inspectZaloWebhookEvent(rawEvent),
    payload: {
      storage: "raw-event",
      version: ZALO_WEBHOOK_SPOOL_VERSION,
      serialize: (rawEvent) => rawEvent,
      deserialize: (rawEvent) => rawEvent,
      createClaimError: (kind) =>
        new ZaloWebhookPayloadError(
          kind === "invalid-version"
            ? "Zalo webhook spool payload is invalid."
            : "Zalo webhook identity changed after durable admission.",
        ),
    },
    deliver: async (_rawEvent, lifecycle, claim) => {
      const update = parseClaimedUpdate(claim.payload, claim.id);
      await options.deliver(
        update,
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
      );
    },
    pollIntervalMs: ZALO_WEBHOOK_DRAIN_INTERVAL_MS,
    // Standard 30-day tombstones dominate the retired 5-minute / 5,000-key replay cache.
    retention: {
      failedMaxEntries: 5_000,
    },
    waitForDeliveryIdleBeforeRepump: false,
    runPumpTask: runDetachedWebhookWork,
    deferredClaims: "wait-on-stop",
    drain: {
      adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
      startLimit: ZALO_WEBHOOK_MAX_CONCURRENT_DELIVERIES,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof ZaloWebhookPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isZaloAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => options.runtime.error?.(`zalo ingress: ${message}`),
    },
    createStoppedError: () => new Error("Zalo ingress stopped."),
    onError: (error) =>
      options.runtime.error?.(`zalo ingress drain failed: ${formatErrorMessage(error)}`),
  });

  return {
    accept: async (rawEvent) => {
      await monitor.admit(rawEvent);
    },
    start: monitor.start,
    stop: monitor.stop,
  };
}

export const zaloWebhookIngressRuntime = { createZaloWebhookIngress };
