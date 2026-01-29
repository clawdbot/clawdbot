import type { DmPolicy, GroupPolicy } from "clawdbot/plugin-sdk";

export type ZoomChannelConfig = {
  requireMention?: boolean;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  toolsBySender?: Record<
    string,
    {
      allow?: string[];
      deny?: string[];
    }
  >;
};

export type ZoomConfig = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  accountId?: string;
  botJid?: string;
  webhookSecretToken?: string;
  webhook?: {
    port?: number;
    path?: string;
  };
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  requireMention?: boolean;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  historyLimit?: number;
  dmHistoryLimit?: number;
  channels?: Record<string, ZoomChannelConfig | undefined>;
  dms?: Record<string, unknown>;
};

export type ZoomCredentials = {
  clientId: string;
  clientSecret: string;
  accountId: string;
  botJid: string;
  webhookSecretToken?: string;
};

export type ZoomChatMessage = {
  id?: string;
  message?: string;
  timestamp?: number;
  sender?: string;
  sender_member_id?: string;
  sender_display_name?: string;
  robot_jid?: string;
};

export type ZoomWebhookEvent = {
  event: string;
  event_ts: number;
  payload: {
    accountId?: string;
    object?: {
      type?: string;
      channel_jid?: string;
      channel_name?: string;
      operator?: string;
      operator_id?: string;
      operator_member_id?: string;
      /** For channel messages, this is the message object */
      message?: ZoomChatMessage;
      userJid?: string;
      user_id?: string;
      user_name?: string;
      user_email?: string;
      robot_jid?: string;
      /** For bot notifications, this is the message text */
      text?: string;
      cmd?: string;
      timestamp?: number;
    };
  };
};

export type ZoomAccessToken = {
  accessToken: string;
  expiresAt: number;
};
