import type { DmPolicy, GroupPolicy } from "clawdbot/plugin-sdk";

export type GoogleChatAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Google Chat account. Default: true. */
  enabled?: boolean;
  /** Google Cloud Project ID. */
  projectId?: string;

  // Pub/Sub mode (for existing bots)
  /** Pub/Sub subscription name (full path: projects/.../subscriptions/...). */
  subscriptionName?: string;
  /** Path to service account credentials JSON file. */
  credentialsPath?: string;

  // Webhook mode (for new bots)
  /** Webhook connection mode. If true, use HTTP webhooks instead of Pub/Sub. */
  webhookMode?: boolean;
  /** Webhook server port. Default: 8790. */
  webhookPort?: number;
  /** Webhook server host. Default: 0.0.0.0. */
  webhookHost?: string;
  /** Webhook path. Default: /google-chat-webhook. */
  webhookPath?: string;
  /** Public webhook URL (for documentation). */
  webhookPublicUrl?: string;

  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (email addresses). */
  allowFrom?: string[];
  /** Group/space access policy (default: disabled). */
  spacePolicy?: GroupPolicy;
  /** Allowlist for spaces (space IDs). */
  allowSpaces?: string[];
  /** Max space messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Outbound message prefix. */
  messagePrefix?: string;
};

export type GoogleChatConfig = {
  /** Optional per-account Google Chat configuration (multi-account). */
  accounts?: Record<string, GoogleChatAccountConfig>;
} & GoogleChatAccountConfig;

export type GoogleChatMessage = {
  name: string;
  sender: {
    name: string;
    displayName: string;
    email?: string;
    type: "HUMAN" | "BOT";
  };
  createTime: string;
  text?: string;
  space: {
    name: string;
    type: "DM" | "ROOM" | "SPACE";
    displayName?: string;
  };
  thread?: {
    name: string;
  };
  argumentText?: string;
  slashCommand?: {
    commandId: string;
  };
};

export type GoogleChatEvent = {
  type: "MESSAGE" | "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE" | "CARD_CLICKED";
  eventTime: string;
  message?: GoogleChatMessage;
  user?: {
    name: string;
    displayName: string;
    email?: string;
  };
  space?: {
    name: string;
    type: string;
    displayName?: string;
  };
};
