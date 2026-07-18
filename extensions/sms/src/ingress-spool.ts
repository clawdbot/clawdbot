// Sms plugin module owns durable Twilio webhook admission and replay.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import { getSmsRuntime } from "./runtime.js";
import {
  buildTwilioInboundMessage,
  resolveTwilioInboundSender,
  resolveTwilioMessageSid,
} from "./twilio.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";

const SMS_INGRESS_PAYLOAD_VERSION = 1;
// Tombstones dominate the retired 10-minute / 10,000-key replay cache.
const SMS_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const SMS_COMPLETED_MAX_ENTRIES = 20_000;
const SMS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SMS_FAILED_MAX_ENTRIES = 1_000;

type SmsIngressPayload = {
  version: typeof SMS_INGRESS_PAYLOAD_VERSION;
  form: Record<string, string>;
};

type SmsIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

class SmsIngressPermanentError extends Error {}

function parseSmsIngressPayload(
  payload: SmsIngressPayload,
  account: ResolvedSmsAccount,
): SmsInboundMessage {
  if (payload.version !== SMS_INGRESS_PAYLOAD_VERSION) {
    throw new SmsIngressPermanentError("SMS ingress payload version is invalid.");
  }
  const message = buildTwilioInboundMessage(payload.form);
  if (!message) {
    throw new SmsIngressPermanentError("SMS ingress payload is invalid.");
  }
  if (message.accountSid && message.accountSid !== account.accountSid) {
    throw new SmsIngressPermanentError("SMS ingress payload has an invalid Twilio account.");
  }
  return message;
}

export function createSmsIngressSpool(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  queue?: ChannelIngressQueue<SmsIngressPayload>;
  abortSignal?: AbortSignal;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
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
  const drain = createChannelIngressDrain<SmsIngressPayload>({
    queue,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.log?.warn ? { onLog: (message: string) => params.log?.warn?.(message) } : {}),
    resolveNonRetryableFailure: (error) =>
      error instanceof SmsIngressPermanentError
        ? { reason: "invalid-payload", message: error.message }
        : null,
    dispatchClaimedEvent: async (event, lifecycle) => {
      await deliver(
        parseSmsIngressPayload(event.payload, params.account),
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
        event.receivedAt,
      );
    },
  });
  return {
    enqueue: async (form: Record<string, string>) => {
      const receivedAt = Date.now();
      const eventId = resolveTwilioMessageSid(form);
      if (!eventId) {
        throw new Error("SMS webhook is missing MessageSid.");
      }
      const sender = resolveTwilioInboundSender(form);
      await queue.prune({
        completedTtlMs: SMS_COMPLETED_TTL_MS,
        completedMaxEntries: SMS_COMPLETED_MAX_ENTRIES,
        failedTtlMs: SMS_FAILED_TTL_MS,
        failedMaxEntries: SMS_FAILED_MAX_ENTRIES,
      });
      const result = await queue.enqueue(
        eventId,
        { version: SMS_INGRESS_PAYLOAD_VERSION, form },
        {
          receivedAt,
          laneKey: sender ? `sender:${sender}` : `event:${eventId}`,
        },
      );
      return { kind: result.kind, duplicate: result.duplicate };
    },
    drainOnce: async () => {
      await drain.drainOnce();
    },
    waitForIdle: drain.waitForIdle,
    dispose: () => drain.dispose(),
  };
}
