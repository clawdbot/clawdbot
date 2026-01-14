import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
}) {
  const { ctx } = params;

  ctx.app.event(
    "member_joined_channel",
    async ({ event }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      try {
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId
          ? await ctx.resolveChannelName(channelId)
          : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user
          ? await ctx.resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} joined ${label}.`, {
          sessionKey,
          contextKey: `slack:member:joined:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack join handler failed: ${String(err)}`),
        );
      }
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      try {
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId
          ? await ctx.resolveChannelName(channelId)
          : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user
          ? await ctx.resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} left ${label}.`, {
          sessionKey,
          contextKey: `slack:member:left:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack leave handler failed: ${String(err)}`),
        );
      }
    },
  );
}
