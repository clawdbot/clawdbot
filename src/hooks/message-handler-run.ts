/**
 * Message handler execution.
 * Runs agent turns for matched message handlers.
 */

import type { CliDeps } from "../cli/outbound-send-deps.js";
import type { MoltbotConfig } from "../config/config.js";
import type { MessageHandlerConfig } from "../config/types.hooks.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent/run.js";
import type { CronJob, CronMessageChannel } from "../cron/types.js";
import { logWarn } from "../logger.js";
import type { MessageReceivedHookContext } from "./internal-hooks.js";

export type RunMessageHandlerParams = {
  cfg: MoltbotConfig;
  deps: CliDeps;
  handler: MessageHandlerConfig;
  context: MessageReceivedHookContext;
};

export type RunMessageHandlerResult = {
  status: "ok" | "error" | "skipped";
  error?: string;
};

/**
 * Execute a message handler by triggering an isolated agent turn.
 */
export async function runMessageHandler(
  params: RunMessageHandlerParams,
): Promise<RunMessageHandlerResult> {
  const { cfg, deps, handler, context } = params;

  try {
    // Build message from template or raw content
    const message = buildHandlerMessage(handler, context);

    // Build session key
    const sessionKey =
      handler.sessionKey ??
      `handler:${handler.id}:${context.channelId}:${context.conversationId ?? "dm"}`;

    // Determine delivery channel
    const channel = normalizeChannel(context.channelId);

    // Determine recipient - reply back to the originating conversation
    const to = context.metadata.originatingTo ?? context.conversationId ?? context.from;

    // Create synthetic cron job for execution
    const now = Date.now();
    const job: CronJob = {
      id: `handler-${handler.id}`,
      name: handler.id,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", atMs: now },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message,
        model: handler.model,
        thinking: handler.thinking,
        timeoutSeconds: handler.timeoutSeconds,
        deliver: true,
        channel,
        to,
      },
      state: {},
    };

    const result = await runCronIsolatedAgentTurn({
      cfg,
      deps,
      job,
      message,
      sessionKey,
      agentId: handler.agentId,
      lane: "message-handler",
    });

    if (result.status === "error") {
      logWarn(`message-handler-run: handler "${handler.id}" failed: ${result.error}`);
      return { status: "error", error: result.error };
    }

    return { status: result.status };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logWarn(`message-handler-run: handler "${handler.id}" threw: ${errorMsg}`);
    return { status: "error", error: errorMsg };
  }
}

/**
 * Build the message to send to the agent from handler config and context.
 */
function buildHandlerMessage(
  handler: MessageHandlerConfig,
  ctx: MessageReceivedHookContext,
): string {
  // If a full template is provided, use it with placeholder substitution
  if (handler.messageTemplate) {
    return handler.messageTemplate
      .replace(/\{\{content\}\}/g, ctx.content)
      .replace(/\{\{from\}\}/g, ctx.from)
      .replace(/\{\{channelId\}\}/g, ctx.channelId)
      .replace(/\{\{conversationId\}\}/g, ctx.conversationId ?? "");
  }

  // Otherwise, use prefix/suffix around raw content
  const prefix = handler.messagePrefix ?? "";
  const suffix = handler.messageSuffix ?? "";
  return `${prefix}${ctx.content}${suffix}`;
}

/**
 * Normalize channel ID to a valid CronMessageChannel.
 */
function normalizeChannel(channelId: string): CronMessageChannel {
  const normalized = channelId.toLowerCase();
  const validChannels: CronMessageChannel[] = [
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "signal",
    "imessage",
    "msteams",
    "last",
  ];
  if (validChannels.includes(normalized as CronMessageChannel)) {
    return normalized as CronMessageChannel;
  }
  // Default to "last" for unknown channels
  return "last";
}
