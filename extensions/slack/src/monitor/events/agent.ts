// Slack plugin module handles Agent View lifecycle events.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSlackAccount } from "../../accounts.js";
import { getSlackRuntime } from "../../runtime.js";
import { markSlackStreamsStopped } from "../../streaming.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveStorePath } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackSessionEventRoutingContext } from "../message-handler/prepare-routing.js";
import { getSlackSessionRuns } from "../session-run-targets.js";
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
    const address = { channelId: event.channel, threadTs: event.thread_ts, eventScope };
    const targets = getSlackSessionRuns(ctx, address);
    const responses: Parameters<typeof deliverSlackSlashResponseWithWebApi>[0]["message"][] = [];
    // One visible Slack thread can have overlapping flat-root and reply sessions.
    // Hold confirmations until every current publisher has passed normal Stop admission.
    const results = [];
    for (const target of targets.length > 0 ? targets : [undefined]) {
      results.push(
        await handleCommand({
          command,
          ack: async () => {},
          respond: async (message) => {
            responses.push(message);
          },
          responseTransport: "web-api",
          body,
          eventScope,
          prompt: "/stop",
          builtInCommand: "stop",
          sessionTarget: target?.route,
          isSessionTargetCurrent: target?.isActive,
          onAdmitted: () => {
            if (target && !target.isActive()) {
              return false;
            }
            // Mark before abort cleanup, but only after authorization: denied Stops must
            // leave fallback delivery available for streams Slack already halted.
            markSlackStreamsStopped(slackClient, event.channel, event.streaming_message_ts);
            return true;
          },
          threadTs: event.thread_ts,
          eventTs: event.event_ts,
        }),
      );
    }
    for (const message of responses) {
      await deliverSlackSlashResponseWithWebApi({
        client: slackClient,
        command,
        threadTs: event.thread_ts,
        message,
      });
    }
    if (!results.every(Boolean) || getSlackSessionRuns(ctx, address).length > 0) {
      return;
    }
    // Recover stale processing only after every owning run completed Stop dispatch.
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
      const isDirectMessage = auth.channelType === "im";
      const isGroupDm = auth.channelType === "mpim";
      const isRoom = auth.channelType === "channel" || auth.channelType === "group";
      const routing = await resolveSlackSessionEventRoutingContext({
        intent: "title",
        ctx,
        account,
        message: {
          type: "message",
          channel: event.channel,
          user: event.user,
          ts: event.event_ts,
          thread_ts: event.thread_ts,
        },
        isDirectMessage,
        isGroupDm,
        isRoom,
        isRoomish: isRoom || isGroupDm,
        eventScope,
      });
      const updated = await getSlackRuntime().agent.session.patchSessionEntry({
        agentId: routing.route.agentId,
        storePath: resolveStorePath(ctx.cfg.session?.store, { agentId: routing.route.agentId }),
        sessionKey: routing.sessionKey,
        preserveActivity: true,
        assertCommitAllowed: () => {
          if (!routing.isCurrentSession()) {
            throw new Error("Slack conversation owner changed before the title update");
          }
        },
        update: () => ({ displayName: event.title }),
      });
      if (!updated) {
        throw new Error("Slack conversation session disappeared before the title update");
      }
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
