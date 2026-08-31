// Defines Google Chat channel configuration types.
import type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";
import type {
  ChannelBotInteractionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { SecretRef } from "./types.secrets.js";

export type GoogleChatDmConfig = {
  /** If false, ignore all incoming Google Chat DMs. Default: true. */
  enabled?: boolean;
};

export type GoogleChatGroupConfig = {
  /** If false, disable the bot in this space. */
  enabled?: boolean;
  /** Require mentioning the bot to trigger replies. */
  requireMention?: boolean;
  /** Sliding-window bot-pair loop guard for accepted bot-authored Google Chat messages. */
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  /** Allowlist of users that can invoke the bot in this space. */
  users?: Array<string | number>;
  /** Optional system prompt for this space. */
  systemPrompt?: string;
};

export type GoogleChatAccountConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns"> &
  ChannelBotInteractionConfig<boolean> & {
    /** Default mention requirement for space messages (default: true). */
    requireMention?: boolean;
    /** Per-space configuration keyed by space id or name. */
    groups?: Record<string, GoogleChatGroupConfig>;
    /** Service account JSON (inline string, object, or secret reference). */
    serviceAccount?: string | Record<string, unknown> | SecretRef;
    /** Service account JSON file path. */
    serviceAccountFile?: string;
    /** Webhook audience type (app-url or project-number). */
    audienceType?: "app-url" | "project-number";
    /** Audience value (app URL or project number). */
    audience?: string;
    /** Exact add-on principal to accept when app-url delivery uses add-on tokens. */
    appPrincipal?: string;
    /** Google Chat webhook path (default: /googlechat). */
    webhookPath?: string;
    /** Google Chat webhook URL (used to derive the path). */
    webhookUrl?: string;
    /** Optional bot user resource name (users/...). */
    botUser?: string;
    /** If false, ignore all incoming Google Chat DMs. Default: true. */
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
