// Slack plugin module implements members behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { readSlackMessages } from "../../actions.js";
import { SlackSystemEventAuthRetryError } from "../auth.js";
import { normalizeSlackChannelType } from "../channel-type.js";
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
    event: SlackMemberChannelEvent & { inviter?: string };
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
      if (paramsLocal.verb === "joined" && payload.user === ctx.botUserId && channelId) {
        const roomType = normalizeSlackChannelType(channelType, channelId);
        if (roomType === "channel" || roomType === "group") {
          // Joining is conversation admission, not a human message: sender allowlists
          // and requireMention cannot apply to the bot's own membership event.
          const roomAllowed = ctx.isChannelAllowed({
            teamId: eventScope?.teamId ?? ctx.teamId,
            channelId,
            channelName: channelInfo.name,
            channelType: roomType,
          });
          const inviterLabel =
            roomAllowed && payload.inviter
              ? ((await ctx.resolveUserName(payload.inviter, eventScope)).name ?? payload.inviter)
              : undefined;
          await reportChannelRoomJoin({
            cfg: ctx.cfg,
            channel: "slack",
            accountId: ctx.accountId,
            conversationId: channelId,
            deliverTo: `channel:${channelId}`,
            route: ctx.resolveSlackSystemEventRoute({
              channelId,
              channelType: roomType,
              eventScope,
            }),
            inviterLabel,
            roomAllowed,
            resolveRoomContext: async ({ messageLimit }) => {
              const purpose = [channelInfo.purpose, channelInfo.topic]
                .filter((value): value is string => Boolean(value?.trim()))
                .join("\n");
              const roomContext = {
                title: channelInfo.name ? `#${channelInfo.name}` : undefined,
                purpose: purpose || undefined,
              };
              try {
                const { messages } = await readSlackMessages(channelId, {
                  limit: messageLimit,
                  client: eventScope?.client ?? ctx.app.client,
                });
                return {
                  ...roomContext,
                  recentMessages: messages
                    .toReversed()
                    .flatMap(({ user, text }) => (text?.trim() ? [{ sender: user, text }] : [])),
                };
              } catch {
                return roomContext;
              }
            },
          });
          return;
        }
      }
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
      enqueueRoutedSystemEvent(
        `Slack: ${userLabel} ${paramsLocal.verb} ${ingressContext.channelLabel}.`,
        ingressContext.route,
        {
          contextKey: `slack:member:${eventScope ? `${eventScope.teamId}:` : ""}${paramsLocal.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}:${paramsLocal.eventId}`,
        },
      );
    } catch (err) {
      ctx.runtime.error?.(
        danger(`slack ${paramsLocal.verb} handler failed: ${formatErrorMessage(err)}`),
      );
      if (err instanceof SlackSystemEventAuthRetryError) {
        throw err;
      }
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
