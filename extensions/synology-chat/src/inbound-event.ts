// Synology Chat plugin module implements inbound event behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { sendMessage } from "./client.js";
import type { SynologyInboundMessage } from "./inbound-context.js";
import { getSynologyRuntime } from "./runtime.js";
import { buildSynologyChatInboundSessionKey } from "./session-key.js";
import type { ResolvedSynologyChatAccount } from "./types.js";
import type { SynologyIngressLifecycle } from "./webhook-ingress.js";

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

// Synology Chat rejects payloads over ~4000 chars ("msg too long"); keep a safety
// margin and chunk longer replies into sequential messages the way the slack, twitch,
// and sms channels already do, instead of dropping the whole reply.
export const SYNOLOGY_CHAT_MAX_MESSAGE_CHARS = 3800;
export const SYNOLOGY_CHAT_CHUNK_DELAY_MS = 1000;

export function chunkSynologyChatReply(text: string): string[] {
  return chunkTextForOutbound(text, SYNOLOGY_CHAT_MAX_MESSAGE_CHARS);
}

async function deliverSynologyChatReply(params: {
  account: ResolvedSynologyChatAccount;
  sendUserId: string;
  payload: { text?: string; body?: string };
}): Promise<{ visibleReplySent: boolean }> {
  const text = params.payload.text ?? params.payload.body;
  if (!text) {
    return { visibleReplySent: false };
  }
  const chunks = chunkSynologyChatReply(text);
  let visibleReplySent = false;
  for (let i = 0; i < chunks.length; i++) {
    const ok = await sendMessage(
      params.account.incomingUrl,
      chunks[i],
      params.sendUserId,
      params.account.allowInsecureSsl,
    );
    visibleReplySent = visibleReplySent || ok;
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, SYNOLOGY_CHAT_CHUNK_DELAY_MS));
    }
  }
  return { visibleReplySent };
}

export async function dispatchSynologyChatInboundEvent(params: {
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  log?: SynologyChannelLog;
  turnAdoptionLifecycle?: SynologyIngressLifecycle;
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

  await resolved.rt.channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
    adapter: {
      ingest: (msg) => ({
        id: `${params.account.accountId}:${msg.from}`,
        timestamp: Date.now(),
        rawText: msg.body,
        textForAgent: msg.body,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const chatKind =
          params.msg.chatType === "group" || params.msg.chatType === "channel"
            ? params.msg.chatType
            : "direct";
        const msgCtx = resolved.rt.channel.inbound.buildContext({
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
          },
          route: {
            agentId: resolved.route.agentId,
            dmScope: resolved.route.dmScope,
            accountId: params.account.accountId,
            routeSessionKey: resolved.sessionKey,
            dispatchSessionKey: resolved.sessionKey,
          },
          reply: {
            to: `synology-chat:${params.msg.from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            ChatType: params.msg.chatType,
            CommandAuthorized: params.msg.commandAuthorized,
          },
        });
        return {
          cfg: currentCfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          route: {
            agentId: resolved.route.agentId,
            dmScope: resolved.route.dmScope,
            sessionKey: resolved.route.sessionKey,
          },
          ctxPayload: msgCtx,
          delivery: {
            durable: () => ({
              to: sendUserId,
            }),
            deliver: async (payload) => {
              return await deliverSynologyChatReply({
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
