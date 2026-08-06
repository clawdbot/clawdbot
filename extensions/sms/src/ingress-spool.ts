// Sms plugin module owns durable Twilio webhook admission and replay.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import { looksLikeSmsPhoneNumber, normalizeSmsPhoneNumber } from "./phone.js";
import { getSmsRuntime } from "./runtime.js";
import {
  buildTwilioInboundMessage,
  resolveTwilioInboundSender,
  resolveTwilioMessageSid,
} from "./twilio.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";

const SMS_INGRESS_PAYLOAD_VERSION = 1;
const SMS_INGRESS_DRAIN_INTERVAL_MS = 500;

type SmsIngressPayload = {
  version: typeof SMS_INGRESS_PAYLOAD_VERSION;
  form: Record<string, string>;
};

type SmsIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

export type SmsIngressLog = Partial<Record<"info" | "warn" | "error", (message: string) => void>>;

class SmsIngressPermanentError extends Error {}

function parseSmsIngressForm(
  form: Record<string, string>,
  account: ResolvedSmsAccount,
): SmsInboundMessage {
  const message = buildTwilioInboundMessage(form);
  if (!message) {
    throw new SmsIngressPermanentError("SMS ingress payload is invalid.");
  }
  if (!message.accountSid || message.accountSid !== account.accountSid) {
    throw new SmsIngressPermanentError("SMS ingress payload has an invalid Twilio account.");
  }
  const isRcsRecipient = /^rcs:/iu.test(message.to);
  if (isRcsRecipient) {
    if (!message.body) {
      throw new SmsIngressPermanentError("SMS ingress payload is invalid.");
    }
    if (
      account.messagingServiceSid &&
      message.messagingServiceSid !== account.messagingServiceSid
    ) {
      throw new SmsIngressPermanentError(
        "SMS ingress payload has an invalid Twilio Messaging Service.",
      );
    }
    // Shipped fromNumber-only RCS callbacks use an agent address in `To`, so
    // they cannot be bound to the phone number without a new RCS config contract.
    // MMS support must not change shipped RCS text behavior. Ignore unsupported
    // RCS media fields until the RCS owner defines its media contract.
    const { unavailableMediaCount: _unavailableMediaCount, ...textMessage } = message;
    return { ...textMessage, media: [] };
  }
  if (account.fromNumber) {
    const recipient = normalizeSmsPhoneNumber(message.to);
    if (!looksLikeSmsPhoneNumber(recipient) || recipient !== account.fromNumber) {
      throw new SmsIngressPermanentError("SMS ingress payload has an invalid Twilio recipient.");
    }
  } else if (
    !message.messagingServiceSid ||
    message.messagingServiceSid !== account.messagingServiceSid
  ) {
    throw new SmsIngressPermanentError(
      "SMS ingress payload has an invalid Twilio Messaging Service.",
    );
  }
  return message;
}

export function createSmsIngressSpool(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  queue?: ChannelIngressQueue<SmsIngressPayload>;
  abortSignal?: AbortSignal;
  log?: SmsIngressLog;
  deliver?: (
    message: SmsInboundMessage,
    lifecycle: SmsIngressLifecycle,
    receivedAt: number,
  ) => Promise<void>;
}) {
  const queue =
    params.queue ??
    getSmsRuntime().state.openChannelIngressQueue<SmsIngressPayload>({
      accountId: params.account.accountId,
    });
  const deliver =
    params.deliver ??
    (async (message: SmsInboundMessage, lifecycle: SmsIngressLifecycle, receivedAt: number) => {
      await dispatchSmsInboundEvent({
        cfg: params.cfg,
        account: params.account,
        channelRuntime: params.channelRuntime,
        msg: message,
        receivedAt,
        turnAdoptionLifecycle: lifecycle,
        log: params.log,
      });
    });
  const monitor = createChannelIngressMonitor<
    Record<string, string>,
    Record<string, string>,
    SmsIngressPayload
  >({
    queue,
    inspect: (form, context) => {
      const eventId = resolveTwilioMessageSid(form);
      if (!eventId) {
        if (context.phase === "claim") {
          throw new SmsIngressPermanentError("SMS ingress payload is invalid.");
        }
        throw new Error("SMS webhook is missing MessageSid.");
      }
      const sender = resolveTwilioInboundSender(form);
      return { eventId, laneKey: sender ? `sender:${sender}` : `event:${eventId}` };
    },
    payload: {
      version: SMS_INGRESS_PAYLOAD_VERSION,
      serialize: (form) => form,
      deserialize: (form) => form,
      encode: ({ body }) => ({ version: SMS_INGRESS_PAYLOAD_VERSION, form: body }),
      decode: (payload) => ({ version: payload.version, body: payload.form }),
      createClaimError: (kind) =>
        new SmsIngressPermanentError(
          kind === "invalid-version"
            ? "SMS ingress payload version is invalid."
            : "SMS ingress identity changed after durable admission.",
        ),
    },
    deliver: (_form, lifecycle, event) =>
      deliver(
        parseSmsIngressForm(event.payload.form, params.account),
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
        event.receivedAt,
      ),
    pollIntervalMs: SMS_INGRESS_DRAIN_INTERVAL_MS,
    // The 1-day / 20k tombstones dominate the retired 10-minute / 10,000-key cache.
    retention: {
      pruneIntervalMs: 0,
      completedTtlMs: 24 * 60 * 60 * 1_000,
      failedMaxEntries: 1_000,
    },
    appendRetryDelaysMs: [0],
    waitForDeliveryIdleBeforeRepump: false,
    // Route replacement must not wait forever for a handler that ignores lifecycle abort.
    // SMS historically disposed immediately; the next route recovers any unsettled claim.
    waitForDeliveryIdleOnStop: false,
    runPumpTask: runDetachedWebhookWork,
    admissionMode: "durable-after-stop",
    drain: {
      onLog: (message) => params.log?.warn?.(message),
      resolveNonRetryableFailure: (error) =>
        error instanceof SmsIngressPermanentError
          ? { reason: "invalid-payload", message: error.message }
          : null,
    },
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    createStoppedError: () => new Error("SMS ingress stopped."),
    onError: (error) =>
      params.log?.error?.(
        `SMS ingress drain failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  return {
    enqueue: async (form: Record<string, string>) => {
      const admitted = await monitor.admit(form);
      if (admitted.kind === "ignored") {
        throw new Error("SMS webhook admission was unexpectedly ignored.");
      }
      return { kind: admitted.queueResult.kind, duplicate: admitted.queueResult.duplicate };
    },
    start: monitor.start,
    pause: monitor.pause,
    waitForIdle: monitor.waitForIdle,
    stop: monitor.stop,
  };
}
