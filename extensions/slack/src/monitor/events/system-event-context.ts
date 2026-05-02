import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";

type SlackAuthorizedSystemEventContext = {
  channelLabel: string;
  sessionKey: string;
};

export async function authorizeAndResolveSlackSystemEventContext(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  eventKind: string;
}): Promise<SlackAuthorizedSystemEventContext | undefined> {
  const { ctx, senderId, channelId, channelType, eventKind } = params;
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType,
  });
  if (!auth.allowed) {
    logVerbose(
      `slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
    );
    return undefined;
  }

  const channelLabel = resolveSlackChannelLabel({
    channelId,
    channelName: auth.channelName,
  });
  const sessionKey = ctx.resolveSlackSystemEventSessionKey({
    channelId,
    channelType: auth.channelType,
    senderId,
  });
  return {
    channelLabel,
    sessionKey,
  };
}
