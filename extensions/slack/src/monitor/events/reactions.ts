import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import type { SlackReactionEvent } from "../types.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

export function registerSlackReactionEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const handleReactionEvent = async (event: SlackReactionEvent, action: string) => {
    try {
      const item = event.item;
      if (!item || item.type !== "message") {
        return;
      }
      trackEvent?.();

      const ingressContext = await authorizeAndResolveSlackSystemEventContext({
        ctx,
        senderId: event.user,
        channelId: item.channel,
        eventKind: "reaction",
      });
      if (!ingressContext) {
        return;
      }

      const actorInfoPromise: Promise<{ name?: string } | undefined> = event.user
        ? ctx.resolveUserName(event.user)
        : Promise.resolve(undefined);
      const authorInfoPromise: Promise<{ name?: string } | undefined> = event.item_user
        ? ctx.resolveUserName(event.item_user)
        : Promise.resolve(undefined);
      const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
      const actorLabel = actorInfo?.name ?? event.user;
      const emojiLabel = event.reaction ?? "emoji";
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      enqueueSystemEvent(text, {
        sessionKey: ingressContext.sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
      });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
    }
  };

  ctx.app.event(
    "reaction_added",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_added">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  ctx.app.event(
    "reaction_removed",
    async ({ event, body }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );
}
