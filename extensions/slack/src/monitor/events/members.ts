// Slack plugin module implements members behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import type { SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type { SlackMemberChannelEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

// The join's own event_ts can repeat across leave/re-invite cycles, so the
// synthetic intro message needs a fresh ts to clear inbound dispatch dedupe.
function buildSelfJoinSyntheticTs(): string {
  const now = Date.now();
  const random = String(Math.floor(Math.random() * 1_000)).padStart(3, "0");
  return `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}${random}`;
}

export function registerSlackMemberEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage?: SlackMessageHandler;
  trackEvent?: () => void;
}) {
  const { ctx, handleSlackMessage, trackEvent } = params;

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
      if (
        paramsLocal.verb === "joined" &&
        channelId &&
        payload.user &&
        payload.user === ctx.botUserId &&
        ctx.selfJoinIntro?.enabled &&
        handleSlackMessage &&
        payload.inviter &&
        payload.inviter !== ctx.botUserId
      ) {
        // Dispatch an immediate agent turn through the normal message pipeline
        // instead of the passive system event. The turn is attributed to the
        // inviter: a bot-authored sender would be dropped by self-message and
        // allowBots filtering, and the invitation is the human action the
        // agent is responding to.
        const instruction =
          ctx.selfJoinIntro.prompt?.trim() ||
          `You were just added to ${ingressContext.channelLabel}. Introduce yourself briefly: say who you are and what you can help with here.`;
        const syntheticMessage: SlackMessageEvent = {
          type: "message",
          channel: channelId,
          channel_type: normalizeSlackChannelType(channelType, channelId),
          user: payload.inviter,
          text: `<@${ctx.botUserId}> [automated channel-join notification] ${instruction}`,
          ts: buildSelfJoinSyntheticTs(),
        };
        logVerbose(`slack: self-join intro channel=${channelId} inviter=${payload.inviter}`);
        await handleSlackMessage(syntheticMessage, {
          source: "message",
          wasMentioned: true,
          eventScope,
        });
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
