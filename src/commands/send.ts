import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramToken } from "../telegram/token.js";

export async function sendCommand(
  opts: {
    to: string;
    message: string;
    provider?: string;
    json?: boolean;
    dryRun?: boolean;
    media?: string;
    gifPlayback?: boolean;
  },
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const provider = (opts.provider ?? "whatsapp").toLowerCase();

  if (opts.dryRun) {
    runtime.log(
      `[dry-run] would send via ${provider} -> ${opts.to}: ${opts.message}${opts.media ? ` (media ${opts.media})` : ""}`,
    );
    return;
  }

  if (provider === "telegram") {
    const { token } = resolveTelegramToken(loadConfig());
    const result = await deps.sendMessageTelegram(opts.to, opts.message, {
      token: token || undefined,
      mediaUrl: opts.media,
    });
    runtime.log(
      success(
        `✅ Sent via telegram. Message ID: ${result.messageId} (chat ${result.chatId})`,
      ),
    );
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "telegram",
            via: "direct",
            to: opts.to,
            chatId: result.chatId,
            messageId: result.messageId,
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (provider === "discord") {
    const result = await deps.sendMessageDiscord(opts.to, opts.message, {
      token: process.env.DISCORD_BOT_TOKEN,
      mediaUrl: opts.media,
    });
    runtime.log(
      success(
        `✅ Sent via discord. Message ID: ${result.messageId} (channel ${result.channelId})`,
      ),
    );
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "discord",
            via: "direct",
            to: opts.to,
            channelId: result.channelId,
            messageId: result.messageId,
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (provider === "slack") {
    const result = await deps.sendMessageSlack(opts.to, opts.message, {
      mediaUrl: opts.media,
    });
    runtime.log(
      success(
        `✅ Sent via slack. Message ID: ${result.messageId} (channel ${result.channelId})`,
      ),
    );
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "slack",
            via: "direct",
            to: opts.to,
            channelId: result.channelId,
            messageId: result.messageId,
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (provider === "signal") {
    const result = await deps.sendMessageSignal(opts.to, opts.message, {
      mediaUrl: opts.media,
    });
    runtime.log(success(`✅ Sent via signal. Message ID: ${result.messageId}`));
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "signal",
            via: "direct",
            to: opts.to,
            messageId: result.messageId,
            mediaUrl: opts.media ?? null,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (provider === "imessage" || provider === "imsg") {
    const result = await deps.sendMessageIMessage(opts.to, opts.message, {
      mediaUrl: opts.media,
    });
    runtime.log(
      success(`✅ Sent via iMessage. Message ID: ${result.messageId}`),
    );
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            provider: "imessage",
            via: "direct",
            to: opts.to,
            messageId: result.messageId,
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
