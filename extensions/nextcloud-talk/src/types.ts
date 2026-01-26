import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
} from "clawdbot/plugin-sdk";

export type NextcloudTalkRoomConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this room. */
  tools?: { allow?: string[]; deny?: string[] };
  /** If specified, only load these skills for this room. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this room. */
  enabled?: boolean;
  /** Optional allowlist for room senders (user ids). */
  allowFrom?: string[];
  /** Optional system prompt snippet for this room. */
  systemPrompt?: string;
};

export type NextcloudTalkAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Nextcloud Talk account. Default: true. */
  enabled?: boolean;
  /** Base URL of the Nextcloud instance (e.g., "https://cloud.example.com"). */
  baseUrl?: string;
  /** Bot shared secret from occ talk:bot:install output. */
  botSecret?: string;
  /** Path to file containing bot secret (for secret managers). */
  botSecretFile?: string;
  /** Optional API user for room lookups (DM detection). */
  apiUser?: string;
  /** Optional API password/app password for room lookups. */
  apiPassword?: string;
  /** Path to file containing API password/app password. */
  apiPasswordFile?: string;
  /** Direct message policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Webhook server port. Default: 8788. */
  webhookPort?: number;
  /** Webhook server host. Default: "0.0.0.0". */
  webhookHost?: string;
  /** Webhook endpoint path. Default: "/nextcloud-talk-webhook". */
  webhookPath?: string;
  /** Public URL for the webhook (used if behind reverse proxy). */
  webhookPublicUrl?: string;
  /** Optional allowlist of user IDs allowed to DM the bot. */
  allowFrom?: string[];
  /** Optional allowlist for Nextcloud Talk room senders (user ids). */
  groupAllowFrom?: string[];
  /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy;
  /** Per-room configuration (key is room token). */
  rooms?: Record<string, NextcloudTalkRoomConfig>;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Media upload max size in MB. */
  mediaMaxMb?: number;
};

export type NextcloudTalkConfig = {
  /** Optional per-account Nextcloud Talk configuration (multi-account). */
  accounts?: Record<string, NextcloudTalkAccountConfig>;
} & NextcloudTalkAccountConfig;

export type CoreConfig = {
  channels?: {
    "nextcloud-talk"?: NextcloudTalkConfig;
  };
  [key: string]: unknown;
};

/**
 * Nextcloud Talk webhook payload types based on Activity Streams 2.0 format.
 * Reference: https://nextcloud-talk.readthedocs.io/en/latest/bots/
 */

/** Actor in the activity (the message sender). */
export type NextcloudTalkActor = {
  type: "Person";
  /** User ID in Nextcloud. */
  id: string;
  /** Display name of the user. */
  name: string;
};

/** The message object in the activity. */
export type NextcloudTalkObject = {
  type: "Note";
  /** Message ID. */
  id: string;
  /** Message text (same as content for text/plain). */
  name: string;
  /** Message content. */
  content: string;
  /** Media type of the content. */
  mediaType: string;
};

/** Target conversation/room. */
export type NextcloudTalkTarget = {
  type: "Collection";
  /** Room token. */
  id: string;
  /** Room display name. */
  name: string;
};

/** Incoming webhook payload from Nextcloud Talk. */
export type NextcloudTalkWebhookPayload = {
  type: "Create" | "Update" | "Delete";
  actor: NextcloudTalkActor;
  object: NextcloudTalkObject;
  target: NextcloudTalkTarget;
};

/** Result from sending a message to Nextcloud Talk. */
export type NextcloudTalkSendResult = {
  messageId: string;
  roomToken: string;
  timestamp?: number;
};

/** Parsed incoming message context. */
export type NextcloudTalkInboundMessage = {
  messageId: string;
  roomToken: string;
  roomName: string;
  senderId: string;
  senderName: string;
  text: string;
  mediaType: string;
  timestamp: number;
  isGroupChat: boolean;
};

/** Headers sent by Nextcloud Talk webhook. */
export type NextcloudTalkWebhookHeaders = {
  /** HMAC-SHA256 signature of the request. */
  signature: string;
  /** Random string used in signature calculation. */
  random: string;
  /** Backend Nextcloud server URL. */
  backend: string;
};

/** Options for the webhook server. */
export type NextcloudTalkWebhookServerOptions = {
  port: number;
  host: string;
  path: string;
  secret: string;
  onMessage: (message: NextcloudTalkInboundMessage) => void | Promise<void>;
  onError?: (error: Error) => void;
  abortSignal?: AbortSignal;
};

/** Options for sending a message. */
export type NextcloudTalkSendOptions = {
  baseUrl: string;
  secret: string;
  roomToken: string;
  message: string;
  replyTo?: string;
};
