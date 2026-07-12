// Slack plugin module implements events behavior.
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import { registerSlackAssistantEvents } from "./events/assistant.js";
import { registerSlackChannelEvents } from "./events/channels.js";
import { registerSlackHomeEvents } from "./events/home.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents } from "./events/messages.js";
import { registerSlackPinEvents } from "./events/pins.js";
import { registerSlackReactionEvents } from "./events/reactions.js";
import type { SlackMessageHandler } from "./message-handler.js";

export function registerSlackMonitorEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
  appHomeSlashCommandName?: string;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  registerSlackMessageEvents({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  if (params.ctx.installationIdentity.kind === "enterprise") {
    return;
  }
  registerSlackReactionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackMemberEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackChannelEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackPinEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackHomeEvents({
    ctx: params.ctx,
    slashCommandName: params.appHomeSlashCommandName,
    trackEvent: params.trackEvent,
  });
  registerSlackInteractionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackAssistantEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
}
