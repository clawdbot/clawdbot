// Nostr helper module supports config schema behavior.
import { buildCommonChannelAccountShape } from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

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
const NostrCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
    "defaultTo",
    "groupAllowFrom",
    "groupPolicy",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "textChunkLimit",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "responsePrefix",
    "mediaMaxMb",
    "replyToMode",
  ],
});

export const NostrConfigSchema = z.object({
  /** Account name (optional display name) */
  name: NostrCommonAccountShape.name,

  /** Optional default account id for routing/account selection. */
  defaultAccount: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: NostrCommonAccountShape.enabled,
  configWrites: NostrCommonAccountShape.configWrites,

  /** Markdown formatting overrides (tables). */
  markdown: NostrCommonAccountShape.markdown,

  /** Private key in hex or nsec bech32 format */
  privateKey: buildSecretInputSchema().optional(),

  /** WebSocket relay URLs to connect to */
  relays: z.array(z.string()).optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: NostrCommonAccountShape.dmPolicy,

  /** Allowed sender pubkeys (npub or hex format) */
  allowFrom: NostrCommonAccountShape.allowFrom,

  /** Profile metadata (NIP-01 kind:0 content) */
  profile: NostrProfileSchema.optional(),
});
