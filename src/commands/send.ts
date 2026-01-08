import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { success } from "../globals.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../infra/outbound/envelope.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "../infra/outbound/format.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";

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
  const provider = normalizeMessageProvider(opts.provider) ?? "whatsapp";

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
    const resolvedTarget = resolveOutboundTarget({
      provider,
      to: opts.to,
    });
    if (!resolvedTarget.ok) {
      throw resolvedTarget.error;
    }
    const results = await withProgress(
      {
        label: `Sending via ${provider}…`,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await deliverOutboundPayloads({
          cfg: loadConfig(),
          provider,
          to: resolvedTarget.to,
          payloads: [{ text: opts.message, mediaUrl: opts.media }],
          deps: {
            sendWhatsApp: deps.sendMessageWhatsApp,
            sendTelegram: deps.sendMessageTelegram,
            sendDiscord: deps.sendMessageDiscord,
            sendSlack: deps.sendMessageSlack,
            sendSignal: deps.sendMessageSignal,
            sendIMessage: deps.sendMessageIMessage,
          },
        }),
    );
    const last = results.at(-1);
    const summary = formatOutboundDeliverySummary(provider, last);
    runtime.log(success(summary));
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          buildOutboundDeliveryJson({
            provider,
            via: "direct",
            to: opts.to,
            result: last,
            mediaUrl: opts.media,
          }),
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

  const result = await withProgress(
    {
      label: `Sending via ${provider}…`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () => await sendViaGateway(),
  );

  runtime.log(
    success(
      formatGatewaySummary({ provider, messageId: result.messageId ?? null }),
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          delivery: buildOutboundDeliveryJson({
            provider,
            via: "gateway",
            to: opts.to,
            result,
            mediaUrl: opts.media ?? null,
          }),
        }),
        null,
        2,
      ),
    );
  }
}
