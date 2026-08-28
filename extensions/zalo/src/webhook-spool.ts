// Zalo plugin owns raw webhook durable admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressError,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeNullableString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { z } from "zod";
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

const nonEmptyWebhookStringSchema = z
  .string()
  .transform((value) => nonEmptyString(value))
  .pipe(z.string());
const optionalWebhookStringSchema = z.string().optional().catch(undefined);
const webhookEnvelopeSchema = z
  .looseObject({
    ok: z.unknown().optional(),
    result: z.looseObject({}).optional().catch(undefined),
  })
  .transform((envelope) => (envelope.ok === true && envelope.result ? envelope.result : envelope));
const webhookAdmissionSchema = z.looseObject({
  message: z.looseObject({
    message_id: nonEmptyWebhookStringSchema,
    chat: z.looseObject({ id: nonEmptyWebhookStringSchema }),
  }),
});
const webhookSenderSchema = z.object({
  id: nonEmptyWebhookStringSchema,
  name: optionalWebhookStringSchema,
  display_name: optionalWebhookStringSchema,
  avatar: optionalWebhookStringSchema,
  is_bot: z.boolean().optional().catch(undefined),
});
const webhookChatSchema = z.object({
  id: nonEmptyWebhookStringSchema,
  chat_type: z.enum(["PRIVATE", "GROUP"]),
});
const webhookMessageSchema = z.object({
  message_id: nonEmptyWebhookStringSchema,
  from: webhookSenderSchema,
  chat: webhookChatSchema,
  date: z.number().finite(),
  text: optionalWebhookStringSchema,
  photo_url: optionalWebhookStringSchema,
  caption: optionalWebhookStringSchema,
  sticker: optionalWebhookStringSchema,
  message_type: optionalWebhookStringSchema,
});
const webhookUpdateSchema = z
  .object({
    event_name: z.enum([
      "message.text.received",
      "message.image.received",
      "message.sticker.received",
      "message.unsupported.received",
    ]),
    message: webhookMessageSchema,
  })
  .superRefine((update, context) => {
    if (update.event_name === "message.text.received" && update.message.text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["message", "text"],
        message: "text event requires message.text",
      });
    }
  });

function parseRawRecord(rawEvent: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvent);
  } catch (error) {
    throw new ZaloWebhookPayloadError("Zalo webhook body contains invalid JSON.", { cause: error });
  }
  const envelope = webhookEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new ZaloWebhookPayloadError("Zalo webhook body must be a JSON object.");
  }
  return envelope.data;
}

function inspectZaloWebhookEvent(rawEvent: string): {
  eventId: string;
  laneKey: string;
  update: Record<string, unknown>;
} {
  const update = parseRawRecord(rawEvent);
  const admission = webhookAdmissionSchema.safeParse(update);
  if (!admission.success) {
    const missingEventId = admission.error.issues.some(
      (issue) =>
        issue.path[0] === "message" && (issue.path.length === 1 || issue.path[1] === "message_id"),
    );
    if (missingEventId) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
    }
    const missingChatId = admission.error.issues.some(
      (issue) => issue.path[0] === "message" && issue.path[1] === "chat",
    );
    if (missingChatId) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
    }
    throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.message_id.");
  }
  const eventId = admission.data.message.message_id;
  const chatId = admission.data.message.chat.id;
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
  const parsed = webhookUpdateSchema.safeParse(facts.update);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join("."));
    if (paths.some((path) => path === "event_name")) {
      throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
    }
    if (paths.some((path) => path === "message.from" || path.startsWith("message.from.id"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.from.id.");
    }
    if (paths.some((path) => path === "message.chat" || path.startsWith("message.chat.id"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message is missing message.chat.id.");
    }
    if (paths.some((path) => path.startsWith("message.chat.chat_type"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid chat type.");
    }
    if (paths.some((path) => path.startsWith("message.date"))) {
      throw new ZaloWebhookPayloadError("Zalo webhook message has an invalid date.");
    }
    if (paths.some((path) => path.startsWith("message.text"))) {
      throw new ZaloWebhookPayloadError("Zalo text event is missing message.text.");
    }
    throw new ZaloWebhookPayloadError("Zalo webhook event_name is unsupported.");
  }
  const { event_name: eventName, message } = parsed.data;
  return {
    event_name: eventName,
    message: {
      message_id: claimedId,
      from: message.from,
      chat: message.chat,
      date: message.date,
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.photo_url !== undefined ? { photo_url: message.photo_url } : {}),
      ...(message.caption !== undefined ? { caption: message.caption } : {}),
      ...(message.sticker !== undefined ? { sticker: message.sticker } : {}),
      ...(message.message_type !== undefined ? { message_type: message.message_type } : {}),
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
