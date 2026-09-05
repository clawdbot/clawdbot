// Slack plugin module implements events behavior.
import type { SlackMonitorContext } from "./context.js";
import { registerSlackAgentEvents } from "./events/agent.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import {
  registerSlackChannelEvents,
  registerSlackChannelIdChangedEvent,
} from "./events/channels.js";
import { registerSlackHomeEvents } from "./events/home.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents as registerSlackMessageEventHandlers } from "./events/messages.js";
import { registerSlackPinEvents } from "./events/pins.js";
import { registerSlackReactionEvents } from "./events/reactions.js";
import type { SlackMessageHandler } from "./message-handler.js";

export function registerSlackCommonEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  registerSlackMessageEventHandlers({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  registerSlackReactionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackPinEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackMemberEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackChannelEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackInteractionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
}

export function registerSlackWorkspaceEvents(params: {
  ctx: SlackMonitorContext;
  appHomeSlashCommandName?: string;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  registerSlackChannelIdChangedEvent({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackHomeEvents({
    ctx: params.ctx,
    slashCommandName: params.appHomeSlashCommandName,
    trackEvent: params.trackEvent,
  });
  registerSlackAgentEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackAssistantEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
}
