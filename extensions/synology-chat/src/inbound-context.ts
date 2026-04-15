import type { ResolvedSynologyChatAccount } from "./types.js";

const CHANNEL_ID = "synology-chat";

export type SynologyInboundMessage = {
  body: string;
  from: string;
  senderName: string;
  provider: string;
  chatType: string;
  accountId: string;
  commandAuthorized: boolean;
  chatUserId?: string;
};

export function buildSynologyChatInboundContext<TContext>(params: {
  finalizeInboundContext: (ctx: Record<string, unknown>) => TContext;
  account: ResolvedSynologyChatAccount;
  msg: SynologyInboundMessage;
  sessionKey: string;
}): TContext {
  const { account, msg, sessionKey } = params;
  return params.finalizeInboundContext({
    Body: msg.body,
    RawBody: msg.body,
    CommandBody: msg.body,
    From: `synology-chat:${msg.from}`,
    To: `synology-chat:${msg.from}`,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `synology-chat:${msg.from}`,
    ChatType: msg.chatType,
    SenderName: msg.senderName,
    SenderId: msg.from,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: msg.senderName || msg.from,
    Timestamp: Date.now(),
    CommandAuthorized: msg.commandAuthorized,
  });
}
