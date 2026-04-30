import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { sendMessage } from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
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
  const currentCfg = rt.config.current() as OpenClawConfig;

  // The Chat API user_id (for sending) may differ from the webhook
  // user_id (used for sessions/pairing). Use chatUserId for API calls.
  const sendUserId = params.msg.chatUserId ?? params.msg.from;
  const resolved = resolveSynologyChatInboundRoute({
    cfg: currentCfg,
    account: params.account,
    userId: params.msg.from,
  });

  await resolved.rt.channel.turn.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    adapter: {
      ingest: (msg) => ({
        id: `${params.account.accountId}:${msg.from}`,
        timestamp: Date.now(),
        rawText: msg.body,
        textForAgent: msg.body,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: (input) => {
        const chatKind =
          params.msg.chatType === "group" || params.msg.chatType === "channel"
            ? params.msg.chatType
            : "direct";
        const msgCtx = resolved.rt.channel.turn.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `synology-chat:${params.msg.from}`,
          sender: {
            id: params.msg.from,
            name: params.msg.senderName,
          },
          conversation: {
            kind: chatKind,
            id: params.msg.from,
            label: params.msg.senderName || params.msg.from,
            routePeer: {
              kind: "direct",
              id: params.msg.from,
            },
          },
          route: {
            agentId: resolved.route.agentId,
            accountId: params.account.accountId,
            routeSessionKey: resolved.sessionKey,
            dispatchSessionKey: resolved.sessionKey,
          },
          reply: {
            to: `synology-chat:${params.msg.from}`,
            originatingTo: `synology-chat:${params.msg.from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
            envelopeFrom: params.msg.senderName,
          },
          extra: {
            ChatType: params.msg.chatType,
            CommandAuthorized: params.msg.commandAuthorized,
          },
        });
        const storePath = resolved.rt.channel.session.resolveStorePath(currentCfg.session?.store, {
          agentId: resolved.route.agentId,
        });
        return {
          cfg: currentCfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: resolved.route.agentId,
          routeSessionKey: resolved.route.sessionKey,
          storePath,
          ctxPayload: msgCtx,
          recordInboundSession: resolved.rt.channel.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            resolved.rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            deliver: async (payload) => {
              await deliverSynologyChatReply({
                account: params.account,
                sendUserId,
                payload,
              });
            },
          },
          dispatcherOptions: {
            onReplyStart: () => {
              params.log?.info?.(`Agent reply started for ${params.msg.from}`);
            },
          },
          record: {
            onRecordError: (err) => {
              params.log?.info?.(`Session metadata update failed for ${params.msg.from}`, err);
            },
          },
        };
      },
    },
  });

  return null;
}
