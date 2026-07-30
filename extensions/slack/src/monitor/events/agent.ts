// Slack plugin module handles Agent View lifecycle events.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
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
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();
      await ctx.recordSlackAgentView();
    } catch (error) {
      ctx.runtime.error?.(
        danger(`slack app_context_changed handler failed: ${formatErrorMessage(error)}`),
      );
    }
  });
}
