import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackChannelConfigResolved } from "./channel-config.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";
import { resolveSlackRoutingContext } from "./message-handler/prepare-routing.js";

/** Native session events address presentation threads, not necessarily session boundaries. */
export async function resolveSlackSessionEventRoute(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  channelId: string;
  threadTs: string;
  userId: string;
  eventTs?: string;
  channelType: string | undefined;
  channelConfig?: SlackChannelConfigResolved | null;
  eventScope?: SlackEventScope;
}) {
  const { ctx, channelId, threadTs, eventScope } = params;
  const observed = ctx.getSlackSessionRoute(channelId, threadTs, eventScope);
  if (observed) {
    return observed;
  }
  const isDirectMessage = params.channelType === "im";
  const isGroupDm = params.channelType === "mpim";
  const isRoom = params.channelType === "channel" || params.channelType === "group";
  const managedThread =
    isDirectMessage &&
    !eventScope &&
    (ctx.getSlackAssistantThreadContext(channelId, threadTs) ||
      (await ctx.isSlackManagedViewThread(channelId, threadTs)) ||
      (await ctx.isSlackAgentView()));
  const routing = resolveSlackRoutingContext({
    ctx,
    account: params.account,
    message: {
      type: "message",
      channel: channelId,
      user: params.userId,
      ts: params.eventTs,
      thread_ts: threadTs,
    },
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish: isRoom || isGroupDm,
    channelConfig: params.channelConfig,
    agentViewThreadTs: managedThread ? threadTs : undefined,
    eventScope,
  });
  return { ...routing.route, sessionKey: routing.sessionKey };
}
