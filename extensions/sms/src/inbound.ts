import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeSmsPhoneNumber } from "./phone.js";
import { sendSmsTextChunks } from "./send.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";

const CHANNEL_ID = "sms";

type SmsLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type SmsChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "pairing" | "reply" | "routing" | "session"
>;

async function authorizeSmsSender(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  from: string;
}) {
  return await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    cfg: params.cfg,
    identity: {
      key: "phone",
      entryIdPrefix: "sms-entry",
    },
    readStoreAllowFrom: async () =>
      await params.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: params.from },
    conversation: {
      kind: "direct",
      id: "direct",
    },
    event: { mayPair: true },
    dmPolicy: params.account.dmPolicy,
    allowFrom: params.account.allowFrom,
  });
}

async function issueSmsPairingChallenge(params: {
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  from: string;
  log?: SmsLog;
}) {
  const issueChallenge = createChannelPairingChallengeIssuer({
    channel: CHANNEL_ID,
    upsertPairingRequest: async (input) =>
      await params.channelRuntime.pairing.upsertPairingRequest({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
        ...input,
      }),
  });
  await issueChallenge({
    senderId: params.from,
    senderIdLine: `Your SMS phone number: ${params.from}`,
    sendPairingReply: async (text) => {
      await sendSmsTextChunks({
        account: params.account,
        to: params.from,
        text,
      });
    },
    onCreated: () => {
      params.log?.info?.(`SMS pairing request created for ${params.from}`);
    },
    onReplyError: (err) => {
      params.log?.warn?.(`SMS pairing reply failed for ${params.from}: ${String(err)}`);
    },
  });
}

export async function dispatchSmsInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  msg: SmsInboundMessage;
  channelRuntime: SmsChannelRuntime;
  log?: SmsLog;
}): Promise<void> {
  const from = normalizeSmsPhoneNumber(params.msg.from);
  const auth = await authorizeSmsSender({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    from,
  });
  if (!auth.senderAccess.allowed) {
    if (auth.senderAccess.decision === "pairing") {
      await issueSmsPairingChallenge({
        account: params.account,
        channelRuntime: params.channelRuntime,
        from,
        log: params.log,
      });
      return;
    }
    params.log?.warn?.(`SMS sender ${from} is not authorized`);
    return;
  }

  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: from,
    },
  });
  const sessionKey = route.sessionKey;

  await params.channelRuntime.inbound.run({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    raw: params.msg,
    adapter: {
      ingest: (msg) => ({
        id: msg.messageSid,
        timestamp: Date.now(),
        rawText: msg.body,
        textForAgent: msg.body,
        textForCommands: msg.body,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = params.channelRuntime.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          timestamp: input.timestamp,
          from: `sms:${from}`,
          sender: {
            id: from,
            name: from,
          },
          conversation: {
            kind: "direct",
            id: from,
            label: from,
          },
          route: {
            agentId: route.agentId,
            accountId: params.account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: {
            to: `sms:${from}`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            MessageSid: params.msg.messageSid,
            To: params.msg.to,
          },
        });
        const storePath = params.channelRuntime.session.resolveStorePath(
          params.cfg.session?.store,
          {
            agentId: route.agentId,
          },
        );
        return {
          cfg: params.cfg,
          channel: CHANNEL_ID,
          accountId: params.account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: params.channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({
              to: from,
            }),
            deliver: async (payload) => {
              const text = payload.text;
              if (!text) {
                return { visibleReplySent: false };
              }
              await sendSmsTextChunks({
                account: params.account,
                to: from,
                text,
              });
              return { visibleReplySent: true };
            },
          },
          dispatcherOptions: {
            onReplyStart: () => {
              params.log?.info?.(`SMS reply started for ${from}`);
            },
          },
        };
      },
    },
  });
}
