import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import type { SlackAppHomeOpenedEvent } from "../types.js";

export function buildSlackHomeView(): HomeView {
  return {
    type: "home",
    callback_id: "openclaw:home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "OpenClaw",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Send a DM, mention OpenClaw in a channel, or use `/openclaw` to start a session.",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This Home tab is safe to show to any workspace member who opens the app.",
          },
        ],
      },
    ],
  };
}

export function registerSlackHomeEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  ctx.app.event(
    "app_home_opened",
    async ({ event, body }: SlackEventMiddlewareArgs<"app_home_opened">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackAppHomeOpenedEvent;
        if (!payload.user || payload.tab === "messages") {
          return;
        }

        await ctx.app.client.views.publish({
          token: ctx.botToken,
          user_id: payload.user,
          view: buildSlackHomeView(),
        });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app home handler failed: ${formatErrorMessage(err)}`));
      }
    },
  );
}
