import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageEvent, SlackReactionEvent } from "../types.js";

export function registerSlackReactionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: string) => {
    try {
      // Check reactionNotifications config (consistent with Telegram/Discord/Signal)
      const reactionMode = ctx.reactionMode ?? "own";
      if (reactionMode === "off") return;

      // Skip bot reactions (consistent with other providers)
      if (event.user === ctx.botUserId) return;

      // For "own" mode, only process reactions on messages sent by this bot
      if (reactionMode === "own" && event.item_user !== ctx.botUserId) return;

      // For "allowlist" mode, only process reactions from allowlisted users
      if (reactionMode === "allowlist") {
        const allowlist = ctx.reactionAllowlist ?? [];
        if (allowlist.length === 0) return;
        const userAllowed = allowlist.some(
          (entry) => String(entry).toLowerCase() === String(event.user).toLowerCase(),
        );
        if (!userAllowed) return;
      }

      const item = event.item;
      if (!item || item.type !== "message") return;

      const channelInfo = item.channel ? await ctx.resolveChannelName(item.channel) : {};
      const channelType = channelInfo?.type as SlackMessageEvent["channel_type"];
      if (
        !ctx.isChannelAllowed({
          channelId: item.channel,
          channelName: channelInfo?.name,
          channelType,
        })
      ) {
        return;
      }

      const channelLabel = resolveSlackChannelLabel({
        channelId: item.channel,
        channelName: channelInfo?.name,
      });
      const actorInfo = event.user ? await ctx.resolveUserName(event.user) : undefined;
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorInfo = event.item_user ? await ctx.resolveUserName(event.item_user) : undefined;
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: item.channel,
        channelType,
      });
      enqueueSystemEvent(text, {
        sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_added">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) return;
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) return;
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );
}
