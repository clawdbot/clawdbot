// Slack plugin module implements home behavior.
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { DEFAULT_SLACK_SUGGESTED_PROMPTS, type SlackMonitorContext } from "../context.js";
import type { SlackAppHomeOpenedEvent } from "../types.js";

function buildSlackHomeView(slashCommandName?: string): HomeView {
  const startSessionText = slashCommandName
    ? `Send a DM, mention OpenClaw in a channel, or use \`/${slashCommandName}\` to start a session.`
    : "Send a DM or mention OpenClaw in a channel to start a session.";
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
          text: startSessionText,
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
  slashCommandName?: string;
  trackEvent?: () => void;
}) {
  const { ctx, slashCommandName, trackEvent } = params;

  ctx.app.event(
    "app_home_opened",
    async ({ event, body }: SlackEventMiddlewareArgs<"app_home_opened">) => {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();

      const payload = event as SlackAppHomeOpenedEvent;
      if (!payload.user) {
        return;
      }
      if (payload.tab === "messages") {
        if (!payload.channel) {
          return;
        }
        const outcome = await ctx.setSlackSuggestedPrompts({
          channelId: payload.channel,
          title: "Try asking",
          prompts: DEFAULT_SLACK_SUGGESTED_PROMPTS,
        });
        // Slack gates threadless calls before work: non-Agent apps get not_agent_app/missing_scope.
        // Thus internal_error also proves Agent View; transport failures stay inconclusive
        // so a network blip cannot durably mark a plain bot as Agent View.
        if (outcome === "accepted" || outcome === "internal_error") {
          await ctx.recordSlackAgentView();
        }
        return;
      }

      await ctx.app.client.views.publish({
        token: ctx.botToken,
        user_id: payload.user,
        view: buildSlackHomeView(slashCommandName),
      });
    },
  );
}
