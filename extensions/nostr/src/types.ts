import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { getPublicKeyFromPrivate } from "./nostr-bus.js";
import { DEFAULT_RELAYS } from "./nostr-bus.js";
import type { NostrProfile } from "./config-schema.js";

export interface NostrAccountConfig {
  enabled?: boolean;
  name?: string;
  privateKey?: string;
  relays?: string[];
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  profile?: NostrProfile;
}

export interface ResolvedNostrAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  privateKey: string;
  publicKey: string;
  relays: string[];
  profile?: NostrProfile;
  config: NostrAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";

/**
 * List all configured Nostr account IDs
 */
export function listNostrAccountIds(cfg: MoltbotConfig): string[] {
  const nostrCfg = (cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;

  // If privateKey is configured at top level, we have a default account
  if (nostrCfg?.privateKey) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

/**
 * Get the default account ID
 */
export function resolveDefaultNostrAccountId(cfg: MoltbotConfig): string {
  const ids = listNostrAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve a Nostr account from config
 */
export function resolveNostrAccount(opts: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedNostrAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const nostrCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.nostr as
    | NostrAccountConfig
    | undefined;

  const baseEnabled = nostrCfg?.enabled !== false;
  const privateKey = nostrCfg?.privateKey ?? "";
  const configured = Boolean(privateKey.trim());

  let publicKey = "";
  if (configured) {
    try {
      publicKey = getPublicKeyFromPrivate(privateKey);
    } catch {
      // Invalid key - leave publicKey empty, configured will indicate issues
    }
  }

  return {
    accountId,
    name: nostrCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    privateKey,
    publicKey,
    relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
    profile: nostrCfg?.profile,
    config: {
      enabled: nostrCfg?.enabled,
      name: nostrCfg?.name,
      privateKey: nostrCfg?.privateKey,
      relays: nostrCfg?.relays,
      dmPolicy: nostrCfg?.dmPolicy,
      allowFrom: nostrCfg?.allowFrom,
      profile: nostrCfg?.profile,
    },
  };
}
