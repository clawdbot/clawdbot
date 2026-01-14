import type { SlackEventMiddlewareArgs } from "@slack/bolt";

import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
}) {
  const { ctx } = params;

  ctx.app.event(
    "channel_created",
    async ({ event }: SlackEventMiddlewareArgs<"channel_created">) => {
      try {
        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel created: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:created:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack channel created handler failed: ${String(err)}`),
        );
      }
    },
  );

  ctx.app.event(
    "channel_rename",
    async ({ event }: SlackEventMiddlewareArgs<"channel_rename">) => {
      try {
        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName =
          payload.channel?.name_normalized ?? payload.channel?.name;
        if (
          !ctx.isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = ctx.resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel renamed: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:renamed:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        ctx.runtime.error?.(
          danger(`slack channel rename handler failed: ${String(err)}`),
        );
      }
    },
  );
}
