import { MarkdownConfigSchema } from "clawdbot/plugin-sdk";
import { z } from "zod";

/**
 * Twitch user roles that can be allowed to interact with the bot
 */
const TwitchRoleSchema = z.enum(["moderator", "owner", "vip", "subscriber", "all"]);

/**
 * Twitch account configuration schema
 */
const TwitchAccountSchema = z.object({
  /** Twitch username */
  username: z.string(),
  /** Twitch OAuth access token (requires chat:read and chat:write scopes) */
  accessToken: z.string(),
  /** Twitch client ID (from Twitch Developer Portal or twitchtokengenerator.com) */
  clientId: z.string().optional(),
  /** Channel name to join */
  channel: z.string().min(1),
  /** Enable this account */
  enabled: z.boolean().optional(),
  /** Allowlist of Twitch user IDs who can interact with the bot (use IDs for safety, not usernames) */
  allowFrom: z.array(z.string()).optional(),
  /** Roles allowed to interact with the bot (e.g., ["moderator", "vip", "subscriber"]) */
  allowedRoles: z.array(TwitchRoleSchema).optional(),
  /** Require @mention to trigger bot responses */
  requireMention: z.boolean().optional(),
  /** Twitch client secret (required for token refresh via RefreshingAuthProvider) */
  clientSecret: z.string().optional(),
  /** Refresh token (required for automatic token refresh) */
  refreshToken: z.string().optional(),
  /** Token expiry time in seconds (optional, for token refresh tracking) */
  expiresIn: z.number().nullable().optional(),
  /** Timestamp when token was obtained (optional, for token refresh tracking) */
  obtainmentTimestamp: z.number().optional(),
});

/**
 * Base configuration properties shared by both single and multi-account modes
 */
const TwitchConfigBaseSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema.optional(),
});

/**
 * Simplified single-account configuration schema
 *
 * Use this for single-account setups. Properties are at the top level,
 * creating an implicit "default" account.
 */
const SimplifiedSchema = z.intersection(TwitchConfigBaseSchema, TwitchAccountSchema);

/**
 * Multi-account configuration schema
 *
 * Use this for multi-account setups. Each key is an account ID (e.g., "default", "secondary").
 */
const MultiAccountSchema = z.intersection(
  TwitchConfigBaseSchema,
  z
    .object({
      /** Per-account configuration (for multi-account setups) */
      accounts: z.record(z.string(), TwitchAccountSchema),
    })
    .refine((val) => Object.keys(val.accounts || {}).length > 0, {
      message: "accounts must contain at least one entry",
    }),
);

/**
 * Twitch plugin configuration schema
 *
 * Supports two mutually exclusive patterns:
 * 1. Simplified single-account: username, accessToken, clientId, channel at top level
 * 2. Multi-account: accounts object with named account configs
 *
 * The union ensures clear discrimination between the two modes.
 */
export const TwitchConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
