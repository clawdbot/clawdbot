import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import { registerSlackChannelEvents } from "./events/channels.js";
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
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}) {
  registerSlackMessageEvents({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  registerSlackReactionEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackMemberEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackChannelEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackPinEvents({ ctx: params.ctx, trackEvent: params.trackEvent });
  registerSlackInteractionEvents({ ctx: params.ctx });
}
