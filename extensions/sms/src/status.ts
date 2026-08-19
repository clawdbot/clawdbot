// Sms plugin module implements status behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import {
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  retrieveTwilioMessagingService,
  type TwilioIncomingPhoneNumber,
  type TwilioMessagingService,
  type TwilioMessageLogEntry,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const TWILIO_ERROR_WEBHOOK_REACHABILITY = "11200";

type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

type SmsTwilioWebhookProbe =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "unavailable";
      reason: string;
    }
  | {
      status: "number-not-found";
      expectedNumber: string;
    }
  | {
      status: "missing";
      phoneNumber: string;
      expectedUrl: string;
      configuredMethod: string;
    }
  | {
      status: "method-mismatch";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "url-mismatch";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "matches";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
      voiceUrl: string;
    }
  | {
      status: "messaging-service-missing";
      serviceSid: string;
      expectedUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-method-mismatch";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-url-mismatch";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-matches";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    };

export type SmsProbe = {
  ok: boolean;
  error?: string;
  webhook: SmsTwilioWebhookProbe;
  recentInbound?: Pick<
    TwilioMessageLogEntry,
    "sid" | "direction" | "status" | "errorCode" | "dateCreated" | "dateSent"
  >;
  recentOutbound?: Pick<
    SmsDeliveryRecord,
    "messageSid" | "status" | "lastObservedAt" | "errorCode" | "conflict"
  >;
  hints: string[];
};

type ProbeOptions = {
  fetchImpl?: typeof fetch;
  deliveryRecords?: readonly SmsDeliveryRecord[];
};

type RemoteProbeOutcome<T> = { kind: "value"; value: T } | { kind: "error"; error: string };

function resolveRemoteProbeTimeoutMs(timeoutMs: number): number {
  const normalized = Math.max(1, Math.floor(timeoutMs));
  const settleMarginMs = Math.min(100, Math.max(1, Math.floor(normalized / 10)));
  return Math.max(0, normalized - settleMarginMs);
}

async function runRemoteProbe<T>(params: {
  label: string;
  timeoutMs: number;
  run: () => Promise<T>;
}): Promise<RemoteProbeOutcome<T>> {
  try {
    const value = await withTimeout(Promise.resolve().then(params.run), params.timeoutMs, {
      message: `timed out after ${params.timeoutMs}ms`,
    });
    return { kind: "value", value };
  } catch (error) {
    return {
      kind: "error",
      error: `${params.label} failed: ${formatErrorMessage(error)}`,
    };
  }
}

function addTailscaleHint(account: ResolvedSmsAccount, hints: string[]): void {
  let host;
  try {
    host = new URL(account.publicWebhookUrl).hostname;
  } catch {
    return;
  }
  if (!host.endsWith(".ts.net")) {
    return;
  }
  hints.push(
    `Tailscale Funnel must expose the exact SMS path: tailscale funnel --bg --set-path ${account.webhookPath} http://127.0.0.1:<gateway-port>${account.webhookPath}`,
  );
}

function compareTwilioWebhook(
  account: ResolvedSmsAccount,
  phoneNumber: TwilioIncomingPhoneNumber | undefined,
): SmsTwilioWebhookProbe {
  if (!account.fromNumber) {
    return {
      status: "skipped",
      reason: "Messaging Service senders do not have one phone-number SMS webhook to inspect.",
    };
  }
  if (!phoneNumber) {
    return { status: "number-not-found", expectedNumber: account.fromNumber };
  }
  const configuredMethod = phoneNumber.smsMethod.toUpperCase();
  if (!phoneNumber.smsUrl) {
    return {
      status: "missing",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredMethod,
    };
  }
  if (configuredMethod && configuredMethod !== "POST") {
    return {
      status: "method-mismatch",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: phoneNumber.smsUrl,
      configuredMethod,
    };
  }
  if (phoneNumber.smsUrl !== account.publicWebhookUrl) {
    return {
      status: "url-mismatch",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: phoneNumber.smsUrl,
      configuredMethod,
    };
  }
  return {
    status: "matches",
    phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
    expectedUrl: account.publicWebhookUrl,
    configuredUrl: phoneNumber.smsUrl,
    configuredMethod,
    voiceUrl: phoneNumber.voiceUrl,
  };
}

function compareTwilioMessagingService(
  account: ResolvedSmsAccount,
  service: TwilioMessagingService,
): SmsTwilioWebhookProbe {
  if (service.useInboundWebhookOnNumber) {
    return {
      status: "unavailable",
      reason:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; configure fromNumber or disable defer-to-sender before probing.",
    };
  }
  const configuredMethod = service.inboundMethod.toUpperCase();
  if (!service.inboundRequestUrl) {
    return {
      status: "messaging-service-missing",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredMethod,
    };
  }
  if (configuredMethod && configuredMethod !== "POST") {
    return {
      status: "messaging-service-method-mismatch",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: service.inboundRequestUrl,
      configuredMethod,
    };
  }
  if (service.inboundRequestUrl !== account.publicWebhookUrl) {
    return {
      status: "messaging-service-url-mismatch",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: service.inboundRequestUrl,
      configuredMethod,
    };
  }
  return {
    status: "messaging-service-matches",
    serviceSid: service.sid || account.messagingServiceSid,
    expectedUrl: account.publicWebhookUrl,
    configuredUrl: service.inboundRequestUrl,
    configuredMethod,
  };
}

function recentInboundSummary(
  messages: TwilioMessageLogEntry[],
): SmsProbe["recentInbound"] | undefined {
  const message = messages[0];
  if (!message) {
    return undefined;
  }
  return {
    sid: message.sid,
    direction: message.direction,
    status: message.status,
    errorCode: message.errorCode,
    dateCreated: message.dateCreated,
    dateSent: message.dateSent,
  };
}

function recentOutboundSummary(
  records: readonly SmsDeliveryRecord[],
): SmsProbe["recentOutbound"] | undefined {
  const record = records[0];
  if (!record) {
    return undefined;
  }
  return {
    messageSid: record.messageSid,
    status: record.status,
    lastObservedAt: record.lastObservedAt,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.conflict ? { conflict: true } : {}),
  };
}

function webhookError(probe: SmsTwilioWebhookProbe): string | undefined {
  switch (probe.status) {
    case "matches":
    case "skipped":
      return undefined;
    case "unavailable":
      return probe.reason;
    case "number-not-found":
      return `Twilio account does not list ${probe.expectedNumber} as an incoming phone number.`;
    case "missing":
      return `Twilio number ${probe.phoneNumber} has no SMS webhook URL configured.`;
    case "method-mismatch":
      return `Twilio number ${probe.phoneNumber} uses ${probe.configuredMethod || "an unknown method"} for SMS webhooks; use POST.`;
    case "url-mismatch":
      return `Twilio number ${probe.phoneNumber} points SMS webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
    case "messaging-service-missing":
      return `Twilio Messaging Service ${probe.serviceSid} has no inbound request URL configured.`;
    case "messaging-service-method-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} uses ${probe.configuredMethod || "an unknown method"} for inbound webhooks; use POST.`;
    case "messaging-service-url-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} points inbound webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
    case "messaging-service-matches":
      return undefined;
  }
  return undefined;
}

export async function probeSmsAccount(params: {
  account: ResolvedSmsAccount;
  timeoutMs: number;
  options?: ProbeOptions;
}): Promise<SmsProbe> {
  const hints: string[] = [];
  addTailscaleHint(params.account, hints);
  const recentOutbound = recentOutboundSummary(params.options?.deliveryRecords ?? []);
  const remoteTimeoutMs = resolveRemoteProbeTimeoutMs(params.timeoutMs);
  let webhook: SmsTwilioWebhookProbe;
  let messageHistoryError: string | undefined;
  let messages: TwilioMessageLogEntry[] = [];
  if (remoteTimeoutMs === 0) {
    webhook = {
      status: "unavailable",
      reason: "Twilio webhook probe skipped because the probe timeout is too short.",
    };
  } else {
    const webhookTask: Promise<RemoteProbeOutcome<SmsTwilioWebhookProbe>> = params.account
      .fromNumber
      ? runRemoteProbe({
          label: "Twilio webhook probe",
          timeoutMs: remoteTimeoutMs,
          run: async () =>
            compareTwilioWebhook(
              params.account,
              (
                await listTwilioIncomingPhoneNumbers({
                  account: params.account,
                  phoneNumber: params.account.fromNumber,
                  fetchImpl: params.options?.fetchImpl,
                  timeoutMs: remoteTimeoutMs,
                })
              )[0],
            ),
        })
      : params.account.messagingServiceSid
        ? runRemoteProbe({
            label: "Twilio webhook probe",
            timeoutMs: remoteTimeoutMs,
            run: async () =>
              compareTwilioMessagingService(
                params.account,
                await retrieveTwilioMessagingService({
                  account: params.account,
                  serviceSid: params.account.messagingServiceSid,
                  fetchImpl: params.options?.fetchImpl,
                  timeoutMs: remoteTimeoutMs,
                }),
              ),
          })
        : Promise.resolve({
            kind: "value",
            value: {
              status: "unavailable",
              reason: "Twilio SMS probe requires fromNumber or messagingServiceSid.",
            },
          });
    const messageTask: Promise<RemoteProbeOutcome<TwilioMessageLogEntry[]>> = params.account
      .fromNumber
      ? runRemoteProbe({
          label: "Twilio message history probe",
          timeoutMs: remoteTimeoutMs,
          run: async () =>
            await listTwilioMessages({
              account: params.account,
              to: params.account.fromNumber,
              pageSize: 3,
              fetchImpl: params.options?.fetchImpl,
              timeoutMs: remoteTimeoutMs,
            }),
        })
      : Promise.resolve({ kind: "value", value: [] });
    const [webhookOutcome, messageOutcome] = await Promise.all([webhookTask, messageTask]);
    webhook =
      webhookOutcome.kind === "value"
        ? webhookOutcome.value
        : { status: "unavailable", reason: webhookOutcome.error };
    if (messageOutcome.kind === "value") {
      messages = messageOutcome.value;
    } else {
      messageHistoryError = messageOutcome.error;
    }
  }
  const recentInbound = recentInboundSummary(messages);
  if (recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY) {
    hints.push(
      "Twilio error 11200 means Twilio could not reach the SMS webhook. Check the public URL, tunnel/Funnel route, and Twilio Messaging webhook method.",
    );
  }
  const error = [
    webhookError(webhook),
    messageHistoryError,
    recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY
      ? `Recent inbound SMS ${recentInbound.sid} has Twilio error 11200.`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return {
    ok: !error,
    ...(error ? { error } : {}),
    webhook,
    ...(recentInbound ? { recentInbound } : {}),
    ...(recentOutbound ? { recentOutbound } : {}),
    hints,
  };
}

export function formatSmsProbeLines(probe: unknown): ChannelCapabilitiesDisplayLine[] {
  if (!probe || typeof probe !== "object") {
    return [];
  }
  const smsProbe = probe as Partial<SmsProbe>;
  const lines: ChannelCapabilitiesDisplayLine[] = [];
  if (smsProbe.ok === true) {
    lines.push({ text: "Probe: ok", tone: "success" });
  } else if (smsProbe.ok === false) {
    lines.push({
      text: `Probe: failed${smsProbe.error ? ` (${smsProbe.error})` : ""}`,
      tone: "error",
    });
  }
  if (
    smsProbe.webhook?.status === "matches" ||
    smsProbe.webhook?.status === "messaging-service-matches"
  ) {
    lines.push({ text: `Twilio SMS webhook: ${smsProbe.webhook.configuredUrl}` });
  } else if (smsProbe.webhook?.status && smsProbe.webhook.status !== "skipped") {
    lines.push({ text: `Twilio SMS webhook: ${smsProbe.webhook.status}`, tone: "warn" });
  }
  if (smsProbe.recentInbound?.sid) {
    const error = smsProbe.recentInbound.errorCode
      ? ` error=${smsProbe.recentInbound.errorCode}`
      : "";
    lines.push({
      text: `Recent inbound: ${smsProbe.recentInbound.status || "unknown"}${error}`,
      tone: smsProbe.recentInbound.errorCode ? "warn" : "muted",
    });
  }
  if (smsProbe.recentOutbound?.messageSid) {
    const error = smsProbe.recentOutbound.errorCode
      ? ` error=${smsProbe.recentOutbound.errorCode}`
      : "";
    const status = smsProbe.recentOutbound.status || "unknown";
    const tone =
      status === "delivered"
        ? "success"
        : status === "failed" ||
            status === "undelivered" ||
            status === "canceled" ||
            status === "conflicted"
          ? "error"
          : "muted";
    lines.push({
      text: `Recent outbound: ${status}${error}`,
      tone,
    });
  }
  for (const hint of smsProbe.hints ?? []) {
    lines.push({ text: hint, tone: "warn" });
  }
  return lines;
}
