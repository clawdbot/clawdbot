// Heartbeat runner channel plugin fixtures build channel plugin contracts for tests.
import type {
  ChannelId,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../../src/channels/plugins/types.public.js";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "../../../src/infra/outbound/send-deps.js";
import { createOutboundTestPlugin } from "../../../src/test-utils/channel-plugins.js";

// Channel plugin fixtures used by heartbeat runner tests.

type HeartbeatSendChannelId = "slack" | "telegram" | "whatsapp";
type HeartbeatSendFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Create an outbound adapter that routes through heartbeat send deps. */
function createHeartbeatOutboundAdapter(channelId: HeartbeatSendChannelId): ChannelOutboundAdapter {
  const resolveSend = (deps: unknown) => {
    const send = resolveOutboundSendDep<HeartbeatSendFn>(deps as OutboundSendDeps, channelId);
    if (!send) {
      throw new Error(`Missing ${channelId} outbound send dependency`);
    }
    return send;
  };
  return {
    deliveryMode: "direct",
    sendText: async ({ to, text, deps, cfg, accountId, replyToId, threadId, ...opts }) => {
      const send = resolveSend(deps);
      const baseOptions = {
        verbose: false,
        cfg,
        accountId,
      };
      const sendOptions =
        channelId === "telegram"
          ? {
              ...baseOptions,
              ...(typeof threadId === "number" ? { messageThreadId: threadId } : {}),
              ...(typeof replyToId === "string" ? { replyToMessageId: Number(replyToId) } : {}),
              ...(opts.silent !== undefined ? { silent: opts.silent } : {}),
            }
          : {
              ...baseOptions,
              ...opts,
              ...(replyToId ? { replyToId } : {}),
              ...(threadId !== undefined ? { threadId } : {}),
            };
      return (await send(to, text, sendOptions)) as never;
    },
    sendMedia: async ({ to, text, mediaUrl, deps, cfg, accountId, ...opts }) => {
      const send = resolveSend(deps);
      return (await send(to, text, {
        verbose: false,
        cfg,
        accountId,
        ...opts,
        mediaUrl,
      })) as never;
    },
  };
}

/** Create a channel plugin fixture with heartbeat/outbound behavior. */
function createHeartbeatChannelPlugin(params: {
  id: HeartbeatSendChannelId;
  label: string;
  docsPath: string;
  heartbeat?: ChannelPlugin["heartbeat"];
  messaging?: ChannelMessagingAdapter;
}): ChannelPlugin {
  return {
    ...createOutboundTestPlugin({
      id: params.id as ChannelId,
      label: params.label,
      docsPath: params.docsPath,
      outbound: createHeartbeatOutboundAdapter(params.id),
      ...(params.messaging ? { messaging: params.messaging } : {}),
    }),
    ...(params.heartbeat ? { heartbeat: params.heartbeat } : {}),
  };
}

/** Slack heartbeat channel fixture. */
export const heartbeatRunnerSlackPlugin = createHeartbeatChannelPlugin({
  id: "slack",
  label: "Slack",
  docsPath: "/channels/slack",
});

/** Telegram heartbeat channel fixture with thread preservation. */
export const heartbeatRunnerTelegramPlugin = createHeartbeatChannelPlugin({
  id: "telegram",
  label: "Telegram",
  docsPath: "/channels/telegram",
  messaging: {
    preserveHeartbeatThreadIdForGroupRoute: true,
  },
});

/** WhatsApp heartbeat channel fixture with readiness checks. */
export const heartbeatRunnerWhatsAppPlugin = createHeartbeatChannelPlugin({
  id: "whatsapp",
  label: "WhatsApp",
  docsPath: "/channels/whatsapp",
  heartbeat: {
    checkReady: async ({ cfg, deps }) => {
      if (cfg.web?.enabled === false) {
        return { ok: false, reason: "whatsapp-disabled" };
      }
      const authExists = await (deps?.webAuthExists ?? (async () => true))();
      if (!authExists) {
        return { ok: false, reason: "whatsapp-not-linked" };
      }
      const listenerActive = deps?.hasActiveWebListener ? deps.hasActiveWebListener() : true;
      if (!listenerActive) {
        return { ok: false, reason: "whatsapp-not-running" };
      }
      return { ok: true, reason: "ok" };
    },
  },
});
