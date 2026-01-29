import { MarkdownConfigSchema, buildChannelConfigSchema } from "clawdbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

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
    { message: "URL must use https:// protocol" }
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

export type NostrProfile = z.infer<typeof NostrProfileSchema>;

/**
 * Bunker account entry for NIP-46 remote signing
 */
export const BunkerAccountSchema = z.object({
  /** Display name for this bunker account */
  name: z.string().optional(),
  /** bunker:// URL (secret stripped after connection) */
  bunkerUrl: z.string(),
  /** Cached user pubkey after successful connection */
  userPubkey: z.string().optional(),
  /** Connection timestamp */
  connectedAt: z.number().optional(),
});

export type BunkerAccountConfig = z.infer<typeof BunkerAccountSchema>;

/**
 * Zod schema for channels.nostr.* configuration
 */
export const NostrConfigSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema,

  /** Private key in hex or nsec bech32 format */
  privateKey: z.string().optional(),

  /** WebSocket relay URLs to connect to */
  relays: z.array(z.string()).optional(),

  /** Bunker accounts for NIP-46 remote signing */
  bunkerAccounts: z.array(BunkerAccountSchema).optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),

  /**
   * DM protocol preference:
   * - "dual" (default): Accept both NIP-04 and NIP-17, send using NIP-17
   * - "nip17": NIP-17 only (private DMs with gift wrap)
   * - "nip04": NIP-04 only (legacy encrypted DMs)
   */
  dmProtocol: z.enum(["dual", "nip17", "nip04"]).optional(),

  /** Allowed sender pubkeys (npub or hex format) */
  allowFrom: z.array(allowFromEntry).optional(),

  /** Profile metadata (NIP-01 kind:0 content) */
  profile: NostrProfileSchema.optional(),
});

export type NostrConfig = z.infer<typeof NostrConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const nostrChannelConfigSchema = buildChannelConfigSchema(NostrConfigSchema);
