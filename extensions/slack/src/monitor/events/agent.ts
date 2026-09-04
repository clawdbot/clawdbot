// Slack plugin module handles Agent View lifecycle events.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSlackAccount } from "../../accounts.js";
import { getSlackRuntime } from "../../runtime.js";
import { markSlackStreamsStopped } from "../../streaming.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveStorePath } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackSessionEventRoute } from "../session-event-route.js";
import { createSlackCommandHandler, deliverSlackSlashResponseWithWebApi } from "../slash.js";
import type {
  SlackAgentSessionStoppedEvent,
  SlackAgentSessionTitleChangedEvent,
  SlackAppContextChangedEvent,
} from "../types.js";
import { resolveSlackListenerEventScope } from "./system-event-context.js";

type SlackAgentEvent =
  | SlackAppContextChangedEvent
  | SlackAgentSessionStoppedEvent
  | SlackAgentSessionTitleChangedEvent;

type SlackAgentEventHandler<Event extends SlackAgentEvent> = (args: {
  event: Event;
  body: unknown;
  context?: AllMiddlewareArgs["context"];
  client?: AllMiddlewareArgs["client"];
}) => Promise<void>;

type SlackAgentEventRegistrar = <Name extends SlackAgentEvent["type"]>(
  name: Name,
  handler: SlackAgentEventHandler<Extract<SlackAgentEvent, { type: Name }>>,
) => void;

export function registerSlackAgentEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;
  const slackApp = ctx.app as unknown as { event: SlackAgentEventRegistrar };
  const account = resolveSlackAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  const handleCommand = createSlackCommandHandler({ ctx, account, trackEvent });

  slackApp.event("app_context_changed", async ({ body }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    trackEvent?.();
    await ctx.recordSlackAgentView();
  });

  slackApp.event("agent_session_stopped", async ({ event, body, context, client }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
    if (eventScope === null) {
      return;
    }
    const slackClient = eventScope?.client ?? ctx.app.client;
    const command = {
      user_id: event.user,
      user_name: event.user,
      channel_id: event.channel,
      channel_name: event.channel,
    };
    await handleCommand({
      command,
      ack: async () => {},
      respond: (message) =>
        deliverSlackSlashResponseWithWebApi({
          client: slackClient,
          command,
          threadTs: event.thread_ts,
          message,
        }),
      responseTransport: "web-api",
      body,
      eventScope,
      prompt: "/stop",
      builtInCommand: "stop",
      onAdmitted: () => {
        // Mark before abort cleanup, but only after authorization: denied Stops must
        // leave fallback delivery available for streams Slack already halted.
        markSlackStreamsStopped(slackClient, event.channel, event.streaming_message_ts);
      },
      threadTs: event.thread_ts,
      eventTs: event.event_ts,
    });
    // Recover stale processing if the turn's earlier active write failed. An unauthorized
    // Stop may clear the indicator cosmetically until the still-running turn ends.
    await ctx.setSlackSessionStatus({
      channelId: event.channel,
      threadTs: event.thread_ts,
      status: "active",
      eventScope,
    });
  });

  slackApp.event("agent_session_title_changed", async ({ event, body, context, client }) => {
    if (ctx.shouldDropMismatchedSlackEvent(body)) {
      return;
    }
    const eventScope = resolveSlackListenerEventScope({ ctx, body, context, client });
    if (eventScope === null) {
      return;
    }
    trackEvent?.();
    try {
      const auth = await authorizeSlackSystemEventSender({
        ctx,
        senderId: event.user,
        channelId: event.channel,
        eventScope,
      });
      if (!auth.allowed) {
        return;
      }
      const route = await resolveSlackSessionEventRoute({
        ctx,
        account,
        channelId: event.channel,
        userId: event.user,
        eventTs: event.event_ts,
        threadTs: event.thread_ts,
        channelType: auth.channelType,
        eventScope,
      });
      await getSlackRuntime().agent.session.patchSessionEntry({
        agentId: route.agentId,
        storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: route.agentId }),
        sessionKey: route.sessionKey,
        preserveActivity: true,
        update: () => ({ displayName: event.title }),
      });
      ctx.recordSlackSessionTitle({
        channelId: event.channel,
        threadTs: event.thread_ts,
        title: event.title,
        eventScope,
      });
    } catch (error) {
      ctx.runtime.error?.(`slack session title update failed: ${formatErrorMessage(error)}`);
    }
  });
}
