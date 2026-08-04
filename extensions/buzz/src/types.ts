import { getPublicKey, nip19 } from "nostr-tools";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
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

const { listAccountIds, resolveDefaultAccountId, resolveAccountConfig } = createAccountListHelpers<
  Record<string, unknown> & BuzzConfigInput
>("buzz", {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  fallbackAccountIdWhenEmpty: false,
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.buzz as BuzzConfigInput | undefined;
    const hasNamedAccounts = Object.keys(channel?.accounts ?? {}).length > 0;
    return Boolean(
      channel?.privateKey ||
      process.env.BUZZ_RELAY_URL?.trim() ||
      process.env.BUZZ_PRIVATE_KEY?.trim() ||
      (!hasNamedAccounts && channel?.relayUrl),
    );
  },
});

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
  return listAccountIds(cfg);
}

export function resolveDefaultBuzzAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultAccountId(cfg);
}

export function resolveBuzzAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBuzzAccount {
  const accountId = normalizeAccountId(params.accountId ?? resolveDefaultBuzzAccountId(params.cfg));
  const rawConfig = resolveAccountConfig(params.cfg, accountId) as BuzzConfigInput;
  const config: BuzzConfig = {
    ...rawConfig,
    groupPolicy: rawConfig.groupPolicy ?? "allowlist",
    groups: normalizeBuzzGroups(rawConfig.groups),
  };
  // Environment credentials are the legacy default-account surface. Named accounts must carry
  // their own identity so a partial entry cannot silently reuse the default Buzz key.
  const useEnv = accountId === DEFAULT_ACCOUNT_ID;
  const relayUrl =
    config.relayUrl?.trim() || (useEnv ? process.env.BUZZ_RELAY_URL?.trim() : "") || "";
  const privateKey =
    normalizeSecretInputString(config.privateKey) ||
    (useEnv ? process.env.BUZZ_PRIVATE_KEY?.trim() : "") ||
    "";
  const authTag =
    normalizeSecretInputString(config.authTag) ||
    (useEnv ? process.env.BUZZ_AUTH_TAG?.trim() : "") ||
    "";
  let publicKey = "";
  if (privateKey) {
    try {
      publicKey = resolveBuzzPublicKey(privateKey);
    } catch {
      // Startup reports the actionable key error.
    }
  }
  return {
    accountId,
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
