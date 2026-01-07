import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { success } from "../globals.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import type { RuntimeEnv } from "../runtime.js";

export async function sendCommand(
  opts: {
    to: string;
    message: string;
    provider?: string;
    json?: boolean;
    dryRun?: boolean;
    media?: string;
    gifPlayback?: boolean;
    account?: string;
  },
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const providerRaw = (opts.provider ?? "whatsapp").toLowerCase();
  const provider = providerRaw === "imsg" ? "imessage" : providerRaw;

  if (opts.dryRun) {
    runtime.log(
      `[dry-run] would send via ${provider} -> ${opts.to}: ${opts.message}${opts.media ? ` (media ${opts.media})` : ""}`,
    );
    return;
  }

  if (
    provider === "telegram" ||
    provider === "discord" ||
    provider === "slack" ||
    provider === "signal" ||
    provider === "imessage"
  ) {
    const results = await deliverOutboundPayloads({
      cfg: loadConfig(),
      provider,
      to: opts.to,
      payloads: [{ text: opts.message, mediaUrl: opts.media }],
      deps: {
        sendWhatsApp: deps.sendMessageWhatsApp,
        sendTelegram: deps.sendMessageTelegram,
        sendDiscord: deps.sendMessageDiscord,
        sendSlack: deps.sendMessageSlack,
        sendSignal: deps.sendMessageSignal,
        sendIMessage: deps.sendMessageIMessage,
      },
    });
    const last = results.at(-1);
    const summary = formatDirectSendSummary(provider, last);
    runtime.log(success(summary));
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider,
            via: "direct",
            to: opts.to,
            messageId: last?.messageId ?? "unknown",
            ...(last && "chatId" in last ? { chatId: last.chatId } : {}),
            ...(last && "channelId" in last ? { channelId: last.channelId } : {}),
            ...(last && "timestamp" in last ? { timestamp: last.timestamp } : {}),
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  // Always send via gateway over WS to avoid multi-session corruption.
  const sendViaGateway = async () =>
    callGateway<{
      messageId: string;
    }>({
      method: "send",
      params: {
        to: opts.to,
        message: opts.message,
        mediaUrl: opts.media,
        gifPlayback: opts.gifPlayback,
        accountId: opts.account,
        provider,
        idempotencyKey: randomIdempotencyKey(),
      },
      timeoutMs: 10_000,
      clientName: "cli",
      mode: "cli",
    });

  const result = await sendViaGateway();

  runtime.log(
    success(
      `✅ Sent via gateway. Message ID: ${result.messageId ?? "unknown"}`,
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          provider: "web",
          via: "gateway",
          to: opts.to,
          messageId: result.messageId,
          mediaUrl: opts.media ?? null,
        },
        null,
        2,
      ),
    );
  }
}

function formatDirectSendSummary(
  provider: string,
  result: OutboundDeliveryResult | undefined,
): string {
  if (!result) {
    return `✅ Sent via ${provider}. Message ID: unknown`;
  }
  if (result.provider === "telegram") {
    return `✅ Sent via telegram. Message ID: ${result.messageId} (chat ${result.chatId})`;
  }
  if (result.provider === "discord") {
    return `✅ Sent via discord. Message ID: ${result.messageId} (channel ${result.channelId})`;
  }
  if (result.provider === "slack") {
    return `✅ Sent via slack. Message ID: ${result.messageId} (channel ${result.channelId})`;
  }
  if (result.provider === "signal") {
    return `✅ Sent via signal. Message ID: ${result.messageId}`;
  }
  if (result.provider === "imessage") {
    return `✅ Sent via iMessage. Message ID: ${result.messageId}`;
  }
  return `✅ Sent via ${provider}. Message ID: ${result.messageId}`;
}
