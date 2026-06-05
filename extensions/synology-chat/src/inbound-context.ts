// Synology Chat plugin module implements inbound context behavior.
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
