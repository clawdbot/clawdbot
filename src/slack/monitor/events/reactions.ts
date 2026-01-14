import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

import { normalizeSlackSlug } from "../allow-list.js";
import {
  resolveSlackChannelConfig,
  shouldEmitSlackReactionNotification,
} from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
}) {
  const { ctx } = params;

  const handleReactionEvent = async (
    event: SlackReactionEvent,
    action: "added" | "removed",
  ) => {
    try {
      const item = event.item;
      if (!event.user) return;
      if (!item?.channel || !item?.ts) return;
      if (item.type && item.type !== "message") return;
      if (ctx.botUserId && event.user === ctx.botUserId) return;

      const channelInfo = await ctx.resolveChannelName(item.channel);
      const channelType = channelInfo?.type;
      const channelName = channelInfo?.name;

      if (
        !ctx.isChannelAllowed({
          channelId: item.channel,
          channelName,
          channelType,
        })
      ) {
        return;
      }

      const isRoom = channelType === "channel" || channelType === "group";
      if (isRoom) {
        const channelConfig = resolveSlackChannelConfig({
          channelId: item.channel,
          channelName,
          channels: ctx.channelsConfig,
        });
        if (channelConfig?.allowed === false) return;
      }

      const actor = await ctx.resolveUserName(event.user);
      const shouldNotify = shouldEmitSlackReactionNotification({
        mode: ctx.reactionMode,
        botId: ctx.botUserId,
        messageAuthorId: event.item_user ?? undefined,
        userId: event.user,
        userName: actor?.name ?? undefined,
        allowlist: ctx.reactionAllowlist,
      });
      if (!shouldNotify) return;

      const emojiLabel = event.reaction ?? "emoji";
      const actorLabel = actor?.name ?? event.user;
      const channelLabel = channelName
        ? `#${normalizeSlackSlug(channelName) || channelName}`
        : `#${item.channel}`;
      const authorInfo = event.item_user
        ? await ctx.resolveUserName(event.item_user)
        : undefined;
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
      ctx.runtime.error?.(
        danger(`slack reaction handler failed: ${String(err)}`),
      );
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event }: SlackEventMiddlewareArgs<"reaction_added">) => {
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );
}
