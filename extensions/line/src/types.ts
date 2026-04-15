import type { messagingApi, webhook } from "@line/bot-sdk";
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";

export type LineTokenSource = "config" | "env" | "file" | "none";

export interface LineThreadBindingsConfig {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSubagentSessions?: boolean;
  spawnAcpSessions?: boolean;
}

interface LineAccountBaseConfig {
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  responsePrefix?: string;
  mediaMaxMb?: number;
  webhookPath?: string;
  threadBindings?: LineThreadBindingsConfig;
  groups?: Record<string, LineGroupConfig>;
}

export interface LineConfig extends LineAccountBaseConfig {
  accounts?: Record<string, LineAccountConfig>;
  defaultAccount?: string;
}

export interface LineAccountConfig extends LineAccountBaseConfig {}

export interface LineGroupConfig {
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  requireMention?: boolean;
  systemPrompt?: string;
  skills?: string[];
}

export interface ResolvedLineAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: LineTokenSource;
  config: LineConfig & LineAccountConfig;
}

export type LineMessageType =
  | messagingApi.TextMessage
  | messagingApi.ImageMessage
  | messagingApi.VideoMessage
  | messagingApi.AudioMessage
  | messagingApi.StickerMessage
  | messagingApi.LocationMessage;

export interface LineWebhookContext {
  event: webhook.Event;
  replyToken?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineSendResult {
  messageId: string;
  chatId: string;
}

export type LineProbeResult = BaseProbeResult<string> & {
  bot?: {
    displayName?: string;
    userId?: string;
    basicId?: string;
    pictureUrl?: string;
  };
};

export type LineFlexMessagePayload = {
  altText: string;
  contents: unknown;
};

export type LineTemplateMessagePayload =
  | {
      type: "confirm";
      text: string;
      confirmLabel: string;
      confirmData: string;
      cancelLabel: string;
      cancelData: string;
      altText?: string;
    }
  | {
      type: "buttons";
      title: string;
      text: string;
      actions: Array<{
        type: "message" | "uri" | "postback";
        label: string;
        data?: string;
        uri?: string;
      }>;
      thumbnailImageUrl?: string;
      altText?: string;
    }
  | {
      type: "carousel";
      columns: Array<{
        title?: string;
        text: string;
        thumbnailImageUrl?: string;
        actions: Array<{
          type: "message" | "uri" | "postback";
          label: string;
          data?: string;
          uri?: string;
        }>;
      }>;
      altText?: string;
    };

export type LineChannelData = {
  quickReplies?: string[];
  location?: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  };
  flexMessage?: LineFlexMessagePayload;
  templateMessage?: LineTemplateMessagePayload;
};
