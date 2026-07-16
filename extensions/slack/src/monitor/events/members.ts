import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleMemberChannelEvent = async (params: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
  }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(params.body)) {
        return;
      }
      trackEvent?.();
      const payload = params.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: payload.user,
        channelId,
        channelType,
        eventKind: `member-${params.verb}`,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(`Slack: ${userLabel} ${params.verb} ${ingressContext.channelLabel}.`, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${String(err)}`));
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      await handleMemberChannelEvent({
        verb: "joined",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async ({ event, body }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      await handleMemberChannelEvent({
        verb: "left",
        event: event as SlackMemberChannelEvent,
        body,
      });
    },
  );
}
