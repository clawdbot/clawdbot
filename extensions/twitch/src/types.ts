/**
 * Twitch channel plugin types.
 *
 * This file defines Twitch-specific types. Generic channel types are imported
 * from Moltbot core.
 */

import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMeta,
} from "../../../src/channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import type {
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelStatusAdapter,
} from "../../../src/channels/plugins/types.adapters.js";
import type { MoltbotConfig } from "../../../src/config/config.js";
import type { OutboundDeliveryResult } from "../../../src/infra/outbound/deliver.js";
import type { RuntimeEnv } from "../../../src/runtime.js";

// ============================================================================
// Twitch-Specific Types
// ============================================================================

/**
 * Twitch user roles that can be allowed to interact with the bot
 */
export type TwitchRole = "moderator" | "owner" | "vip" | "subscriber" | "all";

/**
 * Account configuration for a Twitch channel
 */
export interface TwitchAccountConfig {
  /** Twitch username */
  username: string;
  /** Twitch OAuth access token (requires chat:read and chat:write scopes) */
  accessToken: string;
  /** Twitch client ID (from Twitch Developer Portal or twitchtokengenerator.com) */
  clientId: string;
  /** Channel name to join (required) */
  channel: string;
  /** Enable this account */
  enabled?: boolean;
  /** Allowlist of Twitch user IDs who can interact with the bot (use IDs for safety, not usernames) */
  allowFrom?: Array<string>;
  /** Roles allowed to interact with the bot (e.g., ["mod", "vip", "sub"]) */
  allowedRoles?: TwitchRole[];
  /** Require @mention to trigger bot responses */
  requireMention?: boolean;
  /** Twitch client secret (required for token refresh via RefreshingAuthProvider) */
  clientSecret?: string;
  /** Refresh token (required for automatic token refresh) */
  refreshToken?: string;
  /** Token expiry time in seconds (optional, for token refresh tracking) */
  expiresIn?: number | null;
  /** Timestamp when token was obtained (optional, for token refresh tracking) */
  obtainmentTimestamp?: number;
}

/**
 * Message target for Twitch
 */
export interface TwitchTarget {
  /** Account ID */
  accountId: string;
  /** Channel name (defaults to account's channel) */
  channel?: string;
}

/**
 * Twitch message from chat
 */
export interface TwitchChatMessage {
  /** Username of sender */
  username: string;
  /** Twitch user ID of sender (unique, persistent identifier) */
  userId?: string;
  /** Message text */
  message: string;
  /** Channel name */
  channel: string;
  /** Display name (may include special characters) */
  displayName?: string;
  /** Message ID */
  id?: string;
  /** Timestamp */
  timestamp?: Date;
  /** Whether the sender is a moderator */
  isMod?: boolean;
  /** Whether the sender is the channel owner/broadcaster */
  isOwner?: boolean;
  /** Whether the sender is a VIP */
  isVip?: boolean;
  /** Whether the sender is a subscriber */
  isSub?: boolean;
  /** Chat type */
  chatType?: "group";
}

/**
 * Send result from Twitch client
 */
export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

// Re-export core types for convenience
export type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelStatusAdapter,
  ChannelCapabilities,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelPlugin,
  ChannelOutboundContext,
  OutboundDeliveryResult,
};

// Import and re-export the schema type
import type { TwitchConfigSchema } from "./config-schema.js";
import type { z } from "zod";
export type TwitchConfig = z.infer<typeof TwitchConfigSchema>;

export type { MoltbotConfig };
export type { RuntimeEnv };
