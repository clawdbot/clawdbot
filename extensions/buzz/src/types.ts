import { getPublicKey, nip19 } from "nostr-tools";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BuzzConfig, BuzzConfigInput } from "./config-schema.js";
import { parseBuzzTarget } from "./target.js";

export interface ResolvedBuzzAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  relayUrl: string;
  privateKey: string;
  authTag: string;
  publicKey: string;
  config: BuzzConfig;
}

function resolveChannelConfig(cfg: OpenClawConfig): BuzzConfigInput | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.buzz as BuzzConfigInput | undefined;
}

function normalizeBuzzGroups(groups: BuzzConfigInput["groups"]): BuzzConfig["groups"] {
  if (!groups) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(groups).map(([channelId, group]) => [parseBuzzTarget(channelId), group]),
  );
}

export function decodeBuzzPrivateKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec") {
    throw new Error("Buzz private key must be nsec or 64-character hex");
  }
  return decoded.data;
}

export function resolveBuzzPublicKey(privateKey: string): string {
  return getPublicKey(decodeBuzzPrivateKey(privateKey));
}

export function listBuzzAccountIds(cfg: OpenClawConfig): string[] {
  const config = resolveChannelConfig(cfg);
  const relayUrl = config?.relayUrl?.trim() || process.env.BUZZ_RELAY_URL?.trim();
  const privateKeyConfigured =
    hasConfiguredSecretInput(config?.privateKey, cfg.secrets?.defaults) ||
    Boolean(process.env.BUZZ_PRIVATE_KEY?.trim());
  return relayUrl || privateKeyConfigured ? [DEFAULT_ACCOUNT_ID] : [];
}

export function resolveDefaultBuzzAccountId(_cfg: OpenClawConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function resolveBuzzAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBuzzAccount {
  const rawConfig = resolveChannelConfig(params.cfg) ?? {};
  const config: BuzzConfig = {
    ...rawConfig,
    groupPolicy: rawConfig.groupPolicy ?? "allowlist",
    groups: normalizeBuzzGroups(rawConfig.groups),
  };
  const relayUrl = config.relayUrl?.trim() || process.env.BUZZ_RELAY_URL?.trim() || "";
  const privateKey =
    normalizeSecretInputString(config.privateKey) || process.env.BUZZ_PRIVATE_KEY?.trim() || "";
  const authTag =
    normalizeSecretInputString(config.authTag) || process.env.BUZZ_AUTH_TAG?.trim() || "";
  let publicKey = "";
  if (privateKey) {
    try {
      publicKey = resolveBuzzPublicKey(privateKey);
    } catch {
      // Startup reports the actionable key error.
    }
  }
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: normalizeOptionalString(config.name) ?? "OpenClaw",
    enabled: config.enabled !== false,
    configured: Boolean(relayUrl && privateKey),
    relayUrl,
    privateKey,
    authTag,
    publicKey,
    config,
  };
}
