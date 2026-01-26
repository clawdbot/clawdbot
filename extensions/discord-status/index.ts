/**
 * Discord Status Plugin
 *
 * Updates Discord bot presence/status with session information after each message.
 *
 * NOTE: This plugin requires Discord presence API support to be added to the
 * Discord channel runtime. Currently it logs the status that would be set.
 *
 * To enable full functionality:
 * 1. Add `setPresence` method to Discord runtime
 * 2. Expose it via PluginRuntime.channel.discord.setPresence
 */

import type { PluginApi } from "clawdbot/plugin-sdk";

type DiscordStatusConfig = {
  enabled?: boolean;
  format?: string;
  activityType?: "Playing" | "Watching" | "Listening" | "Competing" | "Custom";
};

export default function register(api: PluginApi) {
  const logger = api.logger;
  const config = (api.config ?? {}) as DiscordStatusConfig;

  if (config.enabled === false) {
    logger.info("Discord status plugin is disabled");
    return;
  }

  const format = config.format ?? "📊 {tokens} tokens";
  const activityType = config.activityType ?? "Custom";

  // Track cumulative tokens per session
  const sessionTokens = new Map<string, number>();

  // Register message_sent hook
  api.registerHook({
    hookName: "message_sent",
    priority: 10,
    handler: async (event, ctx) => {
      // Only update for Discord channel
      if (ctx.channelId !== "discord") {
        return;
      }

      const sessionKey = ctx.sessionKey ?? "unknown";

      // Accumulate token usage (if available in future)
      const currentTokens = sessionTokens.get(sessionKey) ?? 0;
      const newTokens = event.usage?.totalTokens ?? 0;
      const totalTokens = currentTokens + newTokens;
      sessionTokens.set(sessionKey, totalTokens);

      // Format the status string
      const statusText = format
        .replace("{tokens}", totalTokens.toLocaleString())
        .replace("{input}", (event.usage?.inputTokens ?? 0).toLocaleString())
        .replace("{output}", (event.usage?.outputTokens ?? 0).toLocaleString())
        .replace("{model}", event.usage?.model ?? "unknown")
        .replace("{provider}", event.usage?.provider ?? "unknown")
        .replace("{session}", sessionKey);

      // Log what we would set (until Discord presence API is exposed)
      logger.info(`[discord-status] Would set presence: ${activityType} "${statusText}"`);

      // TODO: When Discord runtime exposes setPresence:
      // await api.runtime.channel.discord.setPresence({
      //   status: "online",
      //   activities: [{
      //     name: statusText,
      //     type: activityTypeToNumber(activityType),
      //   }],
      // });
    },
  });

  logger.info("Discord status plugin loaded - listening for message_sent events");
}
