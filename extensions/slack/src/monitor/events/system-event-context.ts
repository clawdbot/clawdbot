// Slack plugin module implements system event context behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { authorizeSlackSystemEventSender } from "../auth.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackEventScope, type SlackEventScope } from "../event-scope.js";

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
  eventScope?: SlackEventScope;
}): Promise<SlackAuthorizedSystemEventContext | undefined> {
  const { ctx, senderId, channelId, channelType, eventKind } = params;
  const auth = await authorizeSlackSystemEventSender({
    ctx,
    senderId,
    channelId,
    channelType,
    eventScope: params.eventScope,
    retryNameLookup: eventKind.startsWith("member-"),
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
    eventScope: params.eventScope,
  });
  return {
    channelLabel,
    sessionKey,
  };
}

export function resolveSlackListenerEventScope(params: {
  ctx: SlackMonitorContext;
  body: unknown;
  context: AllMiddlewareArgs["context"] | undefined;
  client: AllMiddlewareArgs["client"] | undefined;
}): SlackEventScope | null | undefined {
  const resolved = resolveSlackEventScope({
    identity: params.ctx.installationIdentity,
    body: params.body,
    context: params.context,
    client: params.client,
    clientOptions: params.ctx.app.webClientOptions,
  });
  if (!resolved.ok) {
    logVerbose(`slack: drop listener event (${resolved.reason})`);
    return null;
  }
  return resolved.scope;
}
