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

export type { ResolvedSynologyChatAccount } from "./types.js";
