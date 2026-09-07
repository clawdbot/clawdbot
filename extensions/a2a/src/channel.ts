import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { A2A_CHANNEL_ID, createA2aChannelPluginBase } from "./channel-base.js";
import { startA2aGatewayAccount } from "./gateway.js";
import { sendA2aChannelText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { a2aChannelStatus } from "./status.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

function normalizeA2aChannelTarget(raw: string): string | undefined {
  const target = raw.trim().replace(/^a2a:/i, "");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target) ? target : undefined;
}

const a2aChannelMessageAdapter = defineChannelMessageAdapter({
  id: A2A_CHANNEL_ID,
  durableFinal: { capabilities: { text: true } },
  send: {
    text: async (ctx) => {
      const result = await sendA2aChannelText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: A2A_CHANNEL_ID, messageId: result.messageId }],
          kind: "text",
        }),
      };
    },
  },
});

export const a2aChannelPlugin: ChannelPlugin<ResolvedA2aChannelAccount> = createChatChannelPlugin({
  base: {
    ...createA2aChannelPluginBase(),
    messaging: {
      normalizeTarget: normalizeA2aChannelTarget,
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => normalizeA2aChannelTarget(raw) !== undefined,
        hint: "<a2a-peer-name>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peerName = normalizeA2aChannelTarget(target);
        if (!peerName) {
          return null;
        }
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: A2A_CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: peerName },
          chatType: "direct",
          from: `${A2A_CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: peerName,
        });
      },
    },
    status: a2aChannelStatus,
    gateway: {
      startAccount: async (ctx) => await startA2aGatewayAccount(ctx),
    },
    message: a2aChannelMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: A2A_CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendA2aChannelText({ cfg, accountId, to, text }),
    },
  },
});
