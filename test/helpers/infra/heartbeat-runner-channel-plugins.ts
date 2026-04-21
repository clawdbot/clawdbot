import type {
  ChannelId,
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../../src/channels/plugins/types.js";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "../../../src/infra/outbound/send-deps.js";
import { createOutboundTestPlugin } from "../../../src/test-utils/channel-plugins.js";

type HeartbeatSendChannelId = "slack" | "telegram" | "whatsapp";
type HeartbeatSendFn = (
  to: string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function createHeartbeatOutboundAdapter(channelId: HeartbeatSendChannelId): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async ({ to, text, deps, cfg, accountId, replyToId, threadId, ...opts }) => {
      const send = resolveOutboundSendDep<HeartbeatSendFn>(deps as OutboundSendDeps, channelId);
      if (!send) {
        throw new Error(`Missing ${channelId} outbound send dependency`);
      }
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
            }
          : {
              ...baseOptions,
              ...opts,
              ...(replyToId ? { replyToId } : {}),
              ...(threadId !== undefined ? { threadId } : {}),
            };
      return (await send(to, text, sendOptions)) as never;
    },
  };
}

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

export const heartbeatRunnerSlackPlugin = createHeartbeatChannelPlugin({
  id: "slack",
  label: "Slack",
  docsPath: "/channels/slack",
});

export const heartbeatRunnerTelegramPlugin = createHeartbeatChannelPlugin({
  id: "telegram",
  label: "Telegram",
  docsPath: "/channels/telegram",
  messaging: {
    preserveHeartbeatThreadIdForGroupRoute: true,
  },
});

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
