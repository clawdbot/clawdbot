import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  ReplyToMode,
} from "./types.base.js";
import type { DmConfig } from "./types.messages.js";

export type GoogleChatDmConfig = {
  /** If false, ignore all incoming Google Chat DMs. Default: true. */
  enabled?: boolean;
  /** Direct message access policy (default: pairing). */
  policy?: DmPolicy;
  /** Allowlist for DM senders (user ids or emails). */
  allowFrom?: Array<string | number>;
};

export type GoogleChatGroupConfig = {
  /** If false, disable the bot in this space. (Alias for allow: false.) */
  enabled?: boolean;
  /** Legacy allow toggle; prefer enabled. */
  allow?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /** Allowlist of users that can invoke the bot in this space. */
  users?: Array<string | number>;
  /** Optional system prompt for this space. */
  systemPrompt?: string;
};

export type GoogleChatActionConfig = {
  reactions?: boolean;
};

export type GoogleChatAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Google Chat account. Default: true. */
  enabled?: boolean;
  /** Allow bot-authored messages to trigger replies (default: false). */
  allowBots?: boolean;
  /** Default mention requirement for space messages (default: true). */
  requireMention?: boolean;
  /**
   * Controls how space messages are handled:
   * - "open": spaces bypass allowlists; mention-gating applies
   * - "disabled": block all space messages
   * - "allowlist": only allow spaces present in channels.googlechat.groups
   */
  groupPolicy?: GroupPolicy;
  /** Optional allowlist for space senders (user ids or emails). */
  groupAllowFrom?: Array<string | number>;
  /** Per-space configuration keyed by space id or name. */
  groups?: Record<string, GoogleChatGroupConfig>;
  /** Service account JSON (inline string or object). */
  serviceAccount?: string | Record<string, unknown>;
  /** Service account JSON file path. */
  serviceAccountFile?: string;
  /** Webhook audience type (app-url or project-number). */
  audienceType?: "app-url" | "project-number";
  /** Audience value (app URL or project number). */
  audience?: string;
  /** Google Chat webhook path (default: /googlechat). */
  webhookPath?: string;
  /** Google Chat webhook URL (used to derive the path). */
  webhookUrl?: string;
  /** Optional bot user resource name (users/...). */
  botUser?: string;
  /** Max space messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user id. */
  dms?: Record<string, DmConfig>;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  /** Per-action tool gating (default: true for all). */
  actions?: GoogleChatActionConfig;
  dm?: GoogleChatDmConfig;
  /**
   * Typing indicator mode (default: "message").
   * - "none": No indicator
   * - "message": Send "_<name> is typing..._" then edit with response
   * - "reaction": React with 👀 to user message, remove on reply
   *   NOTE: Reaction mode requires user OAuth (not supported with service account auth).
   *   If configured, falls back to message mode with a warning.
   */
  typingIndicator?: "none" | "message" | "reaction";
};

export type GoogleChatConfig = {
  /** Optional per-account Google Chat configuration (multi-account). */
  accounts?: Record<string, GoogleChatAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & GoogleChatAccountConfig;
