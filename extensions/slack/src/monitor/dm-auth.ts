import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { resolveSlackAllowListMatch } from "./allow-list.js";
import type { SlackMonitorContext } from "./context.js";
import { upsertChannelPairingRequest } from "./conversation.runtime.js";

export async function authorizeSlackDirectMessage(params: {
  ctx: SlackMonitorContext;
  accountId: string;
  senderId: string;
  allowFromLower: string[];
  resolveSenderName: (senderId: string) => Promise<{ name?: string }>;
  sendPairingReply: (text: string) => Promise<void>;
  onDisabled: () => Promise<void> | void;
  onUnauthorized: (params: { allowMatchMeta: string; senderName?: string }) => Promise<void> | void;
  log: (message: string) => void;
}): Promise<boolean> {
  if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
    await params.onDisabled();
    return false;
  }
  if (params.ctx.dmPolicy === "open") {
    return true;
  }

  const sender = await params.resolveSenderName(params.senderId);
  const senderName = sender?.name ?? undefined;
  const allowMatch = resolveSlackAllowListMatch({
    allowList: params.allowFromLower,
    id: params.senderId,
    name: senderName,
    allowNameMatching: params.ctx.allowNameMatching,
  });
  const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
  if (allowMatch.allowed) {
    return true;
  }

  if (params.ctx.dmPolicy === "pairing") {
    await createChannelPairingChallengeIssuer({
      channel: "slack",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          channel: "slack",
          id,
          accountId: params.accountId,
          meta,
        }),
    })({
      senderId: params.senderId,
      senderIdLine: `Your Slack user id: ${params.senderId}`,
      meta: { name: senderName },
      sendPairingReply: params.sendPairingReply,
      onCreated: () => {
        params.log(
          `slack pairing request sender=${params.senderId} name=${senderName ?? "unknown"} (${allowMatchMeta})`,
        );
      },
      onReplyError: (err) => {
        params.log(`slack pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
    });
    return false;
  }

  await params.onUnauthorized({ allowMatchMeta, senderName });
  return false;
}
