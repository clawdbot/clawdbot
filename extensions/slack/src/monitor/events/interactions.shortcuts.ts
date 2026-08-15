// Slack plugin module implements shortcut interaction behavior.
import type {
  AllMiddlewareArgs,
  GlobalShortcut,
  MessageShortcut,
  SlackShortcutMiddlewareArgs,
} from "@slack/bolt";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackDeferredActionTarget } from "../deferred-action-routing.js";
import { resolveSlackListenerEventScope } from "../event-scope.js";

type SlackShortcutBody = GlobalShortcut | MessageShortcut;
type SlackShortcutHandlerArgs = SlackShortcutMiddlewareArgs &
  Pick<AllMiddlewareArgs, "context" | "client">;

function resolveMessageThreadTs(body: MessageShortcut): string | undefined {
  const threadTs = body.message.thread_ts;
  return typeof threadTs === "string" && threadTs.trim() ? threadTs.trim() : undefined;
}

async function handleSlackShortcut(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  args: SlackShortcutHandlerArgs;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { ack, body } = params.args;
  await ack();
  const eventScope = resolveSlackListenerEventScope({
    identity: params.ctx.installationIdentity,
    body,
    context: params.args.context,
    client: params.args.client,
    clientOptions: params.ctx.app.webClientOptions,
    onDrop: (reason) => params.ctx.runtime.log?.(`slack:interaction drop shortcut ${reason}`),
  });
  if (eventScope === null) {
    return;
  }
  if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
    params.ctx.runtime.log?.("slack:interaction drop shortcut payload (mismatched app/team)");
    return;
  }

  const callbackId = body.callback_id?.trim();
  const userId = body.user?.id?.trim();
  if (!callbackId || !userId) {
    params.ctx.runtime.log?.("slack:interaction drop shortcut reason=invalid-payload");
    return;
  }
  params.trackEvent?.();

  const isMessageShortcut = body.type === "message_action";
  const messageBody = isMessageShortcut ? body : undefined;
  const channelId = messageBody?.channel.id?.trim() || undefined;
  if (isMessageShortcut && !channelId) {
    params.ctx.runtime.log?.(
      `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=missing-channel`,
    );
    return;
  }
  const threadTs = messageBody ? resolveMessageThreadTs(messageBody) : undefined;
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    eventScope,
    senderId: userId,
    channelId,
    channelType: isMessageShortcut ? undefined : "im",
    expectedSenderId: userId,
    interactiveEvent: true,
  });
  if (!auth.allowed) {
    params.ctx.runtime.log?.(
      `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`,
    );
    return;
  }

  const interactionType = isMessageShortcut ? "message_shortcut" : "global_shortcut";
  const messageTs = messageBody?.message.ts || messageBody?.message_ts;
  const teamId = params.args.context.teamId;
  const deferredTarget = resolveSlackDeferredActionTarget({
    eventScope,
    kind: auth.channelType === "im" ? "user" : "channel",
    id: auth.channelType === "im" ? userId : (channelId ?? ""),
  });
  const eventPayload = {
    interactionType,
    actionId: `shortcut:${callbackId}`,
    callbackId,
    userId,
    teamId,
    triggerId: body.trigger_id,
    actionTs: body.action_ts,
    channelId,
    channelName: messageBody?.channel.name,
    messageTs,
    threadTs,
    messageUserId: messageBody?.message.user,
    messageText: messageBody?.message.text,
    responseUrl: messageBody?.response_url,
  };
  const route = params.ctx.resolveSlackSystemEventRoute({
    channelId,
    channelType: auth.channelType,
    senderId: userId,
    threadTs,
    eventScope,
  });
  const contextKey = [
    "slack:interaction:shortcut",
    interactionType,
    teamId,
    callbackId,
    channelId,
    messageTs,
    body.action_ts,
  ]
    .filter(Boolean)
    .join(":");

  params.ctx.runtime.log?.(
    `slack:interaction ${interactionType} callback=${callbackId} user=${userId} channel=${channelId ?? "direct"}`,
  );
  const queued = enqueueRoutedSystemEvent(params.formatSystemEvent(eventPayload), route, {
    contextKey,
    deliveryContext: {
      channel: "slack",
      to: deferredTarget.target,
      accountId: params.ctx.accountId,
      threadId: threadTs,
    },
  });
  if (queued) {
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "hook:slack-interaction",
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      heartbeat: { target: "last" },
    });
  }
}

export function registerSlackShortcutHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  if (typeof params.ctx.app.shortcut !== "function") {
    return;
  }
  params.ctx.app.shortcut(
    /.+/,
    async (
      args: SlackShortcutMiddlewareArgs<SlackShortcutBody> &
        Pick<AllMiddlewareArgs, "context" | "client">,
    ) => {
      await handleSlackShortcut({
        ctx: params.ctx,
        trackEvent: params.trackEvent,
        args,
        formatSystemEvent: params.formatSystemEvent,
      });
    },
  );
}
