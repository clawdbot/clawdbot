// Slack plugin module handles Agent View lifecycle events.
import type { SlackMonitorContext } from "../context.js";
import type { SlackAppContextChangedEvent } from "../types.js";

type SlackAgentEventHandler = (args: {
  event: SlackAppContextChangedEvent;
  body: unknown;
}) => Promise<void>;

type SlackAgentEventRegistrar = (
  name: "app_context_changed",
  handler: SlackAgentEventHandler,
) => void;

export function registerSlackAgentEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAgentEventRegistrar };

  slackApp.event("app_context_changed", async ({ body }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();
    await ctx.recordSlackAgentView();
  });
}
