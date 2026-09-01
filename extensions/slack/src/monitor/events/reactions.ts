// Slack plugin module implements reactions behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { allowListMatches, normalizeAllowListLower } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import type { SlackReactionEvent } from "../types.js";
import {
  authorizeAndResolveSlackSystemEventContext,
  resolveSlackListenerEventScope,
} from "./system-event-context.js";

function shouldEmitSlackReactionNotification(params: {
  ctx: SlackMonitorContext;
  event: SlackReactionEvent;
  eventScope?: SlackEventScope;
  actorName?: string;
}) {
  const { ctx, event, actorName } = params;
  if (ctx.reactionMode === "off") {
    return false;
  }
  if (ctx.reactionMode === "own") {
    return Boolean(ctx.botUserId && event.item_user === ctx.botUserId);
  }
  if (ctx.reactionMode === "allowlist") {
    const allowList = normalizeAllowListLower(ctx.reactionAllowlist);
    if (allowList.length === 0) {
      return false;
    }
    return allowListMatches({
      allowList,
      teamId: params.eventScope?.teamId ?? ctx.teamId,
      id: event.user,
      name: actorName,
      allowNameMatching: ctx.allowNameMatching,
    });
  }
  return ctx.reactionMode === "all";
}

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const resolveUserName = (userId: string, eventScope?: SlackEventScope) =>
    eventScope ? ctx.resolveUserName(userId, eventScope) : ctx.resolveUserName(userId);

  const handleReactionEvent = async (
    event: SlackReactionEvent,
    action: "added" | "removed",
    eventScope: SlackEventScope | undefined,
    eventId: string,
  ) => {
    try {
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }
      if (ctx.reactionMode === "off") {
        return;
      }
      if (ctx.reactionMode === "own" && (!ctx.botUserId || event.item_user !== ctx.botUserId)) {
        return;
      }
      trackEvent?.();

      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: event.user,
        channelId: item.channel,
        eventKind: "reaction",
        eventScope,
      });
      if (!ingressContext) {
        return;
      }

      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? resolveUserName(event.user, eventScope)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
        ? resolveUserName(event.item_user, eventScope)
        : Promise.resolve(undefined);
      const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
      if (
        !shouldEmitSlackReactionNotification({
          ctx,
          event,
          eventScope,
          actorName: actorInfo?.name,
        })
      ) {
        return;
      }
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      enqueueRoutedSystemEvent(text, ingressContext.route, {
        contextKey: `slack:reaction:${eventScope ? `${eventScope.teamId}:` : ""}${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}:${eventId}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${formatErrorMessage(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async (args: SlackEventMiddlewareArgs<"reaction_added"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "added", eventScope, body.event_id);
    },
  );

  ctx.app.event(
    "reaction_removed",
    async (args: SlackEventMiddlewareArgs<"reaction_removed"> & AllMiddlewareArgs) => {
      const { event, body, context, client } = args;
      const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
      if (eventScope === null) {
        return;
      }
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "removed", eventScope, body.event_id);
    },
  );
}
