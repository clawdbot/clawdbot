// Slack plugin module implements members behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMemberChannelEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleMemberChannelEvent = async (paramsLocal: {
    verb: "joined" | "left";
    event: SlackMemberChannelEvent;
    body: unknown;
    eventId: string;
    context: AllMiddlewareArgs["context"];
    client: AllMiddlewareArgs["client"];
  }) => {
    try {
      const eventScope = resolveSlackListenerEventScope({
        ctx,
        body: paramsLocal.body,
        context: paramsLocal.context,
        client: paramsLocal.client,
      });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(paramsLocal.body)) {
        return;
      }
      trackEvent?.();
      const payload = paramsLocal.event;
      const channelId = payload.channel;
      const channelInfo = channelId ? await ctx.resolveChannelName(channelId, eventScope) : {};
      const channelType = payload.channel_type ?? channelInfo?.type;
      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: payload.user,
        channelId,
        channelType,
        eventKind: `member-${paramsLocal.verb}`,
        eventScope,
      });
      if (!ingressContext) {
        return;
      }
      const userInfo = payload.user ? await ctx.resolveUserName(payload.user, eventScope) : {};
      const userLabel = userInfo?.name ?? payload.user ?? "someone";
      enqueueSystemEvent(
        `Slack: ${userLabel} ${paramsLocal.verb} ${ingressContext.channelLabel}.`,
        {
          sessionKey: ingressContext.sessionKey,
          contextKey: `slack:member:${eventScope ? `${eventScope.teamId}:` : ""}${paramsLocal.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}:${paramsLocal.eventId}`,
        },
      );
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack ${paramsLocal.verb} handler failed: ${formatErrorMessage(err)}`),
      );
    }
  };

  ctx.app.event(
    "member_joined_channel",
    async (args: SlackEventMiddlewareArgs<"member_joined_channel"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      await handleMemberChannelEvent({
        verb: "joined",
        event: event as SlackMemberChannelEvent,
        body,
        eventId: body.event_id,
        context,
        client,
      });
    },
  );

  ctx.app.event(
    "member_left_channel",
    async (args: SlackEventMiddlewareArgs<"member_left_channel"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      await handleMemberChannelEvent({
        verb: "left",
        event: event as SlackMemberChannelEvent,
        body,
        eventId: body.event_id,
        context,
        client,
      });
    },
  );
}
