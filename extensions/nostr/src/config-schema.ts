import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  DmPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-primitives";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "openclaw/plugin-sdk/zod";

/**
 * Validates https:// URLs only (no javascript:, data:, file:, etc.)
 */
const safeUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use https:// protocol" },
  );

/**
 * NIP-01 profile metadata schema
 * https://github.com/nostr-protocol/nips/blob/master/01.md
 */
export const NostrProfileSchema = z.object({
  /** Username (NIP-01: name) - max 256 chars */
  name: z.string().max(256).optional(),

  /** Display name (NIP-01: display_name) - max 256 chars */
  displayName: z.string().max(256).optional(),

  /** Bio/description (NIP-01: about) - max 2000 chars */
  about: z.string().max(2000).optional(),

  /** Profile picture URL (must be https) */
  picture: safeUrlSchema.optional(),

  /** Banner image URL (must be https) */
  banner: safeUrlSchema.optional(),

  /** Website URL (must be https) */
  website: safeUrlSchema.optional(),

  /** NIP-05 identifier (e.g., "user@example.com") */
  nip05: z.string().optional(),

  /** Lightning address (LUD-16) */
  lud16: z.string().optional(),
});

export interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}

/**
 * Zod schema for channels.nostr.* configuration
 */
export const NostrConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Optional default account id for routing/account selection. */
  defaultAccount: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema,

  /** Private key in hex or nsec bech32 format */
  privateKey: buildSecretInputSchema().optional(),

  /** WebSocket relay URLs to connect to */
  relays: z.array(z.string()).optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: DmPolicySchema.optional(),

  /** Allowed sender pubkeys (npub or hex format) */
  allowFrom: AllowFromListSchema,

  /** Profile metadata (NIP-01 kind:0 content) */
  profile: NostrProfileSchema.optional(),
});

export type NostrConfig = z.infer<typeof NostrConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const nostrChannelConfigSchema = buildChannelConfigSchema(NostrConfigSchema);
