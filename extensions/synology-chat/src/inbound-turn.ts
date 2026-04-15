import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { sendMessage } from "./client.js";
import { buildSynologyChatInboundContext, type SynologyInboundMessage } from "./inbound-context.js";
import { getSynologyRuntime } from "./runtime.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

type SynologyChannelLog = {
  info?: (...args: unknown[]) => void;
};

function resolveSynologyChatInboundRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedSynologyChatAccount;
  userId: string;
}) {
  const rt = getSynologyRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.userId,
    },
  });
  return {
    rt,
    route,
    sessionKey: buildSynologyChatInboundSessionKey({
      agentId: route.agentId,
      accountId: params.account.accountId,
      userId: params.userId,
      identityLinks: params.cfg.session?.identityLinks,
    }),
  };
}

async function deliverSynologyChatReply(params: {
  account: ResolvedSynologyChatAccount;
  sendUserId: string;
  payload: { text?: string; body?: string };
}): Promise<void> {
  const text = params.payload.text ?? params.payload.body;
  if (!text) {
    return;
  }
  await sendMessage(
    params.account.incomingUrl,
    text,
    params.sendUserId,
    params.account.allowInsecureSsl,
  );
}

export async function dispatchSynologyChatInboundTurn(params: {
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  log?: SynologyChannelLog;
}): Promise<null> {
  const rt = getSynologyRuntime();
  const currentCfg = rt.config.loadConfig();

  // The Chat API user_id (for sending) may differ from the webhook
  // user_id (used for sessions/pairing). Use chatUserId for API calls.
  const sendUserId = params.msg.chatUserId ?? params.msg.from;
  const resolved = resolveSynologyChatInboundRoute({
    cfg: currentCfg,
    account: params.account,
    userId: params.msg.from,
  });
  const msgCtx = buildSynologyChatInboundContext({
    finalizeInboundContext: resolved.rt.channel.reply.finalizeInboundContext,
    account: params.account,
    msg: params.msg,
    sessionKey: resolved.sessionKey,
  });

  await resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg: currentCfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; body?: string }) => {
        await deliverSynologyChatReply({
          account: params.account,
          sendUserId,
          payload,
        });
      },
      onReplyStart: () => {
        params.log?.info?.(`Agent reply started for ${params.msg.from}`);
      },
    },
  });

  return null;
}
