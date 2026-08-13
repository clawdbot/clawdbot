import { getPublicKey, nip19 } from "nostr-tools";
import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-resolution-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  BuzzAccountConfig,
  BuzzAccountConfigInput,
  BuzzConfigInput,
} from "./config-schema.js";
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
  config: BuzzAccountConfig;
}

function resolveChannelConfig(cfg: OpenClawConfig): BuzzConfigInput | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.buzz as BuzzConfigInput | undefined;
}

function normalizeBuzzGroups(
  groups: BuzzAccountConfigInput["groups"],
): BuzzAccountConfig["groups"] {
  if (!groups) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(groups).map(([channelId, group]) => [parseBuzzTarget(channelId), group]),
  );
}

const BUZZ_ACCOUNT_OWNED_KEYS = [
  "name",
  "relayUrl",
  "privateKey",
  "authTag",
  "groups",
  "defaultTo",
] as const;

const { listAccountIds: listBuzzAccountIds, resolveDefaultAccountId: resolveDefaultBuzzAccountId } =
  createAccountListHelpers<BuzzAccountConfigInput>("buzz", {
    normalizeAccountId,
    fallbackAccountIdWhenEmpty: false,
    hasImplicitDefaultAccount: (cfg) => {
      const config = resolveChannelConfig(cfg);
      return Boolean(
        config?.relayUrl?.trim() ||
        hasConfiguredSecretInput(config?.privateKey, cfg.secrets?.defaults) ||
        process.env.BUZZ_RELAY_URL?.trim() ||
        process.env.BUZZ_PRIVATE_KEY?.trim(),
      );
    },
  });

export { listBuzzAccountIds, resolveDefaultBuzzAccountId };

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

export function resolveBuzzAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): BuzzAccountConfigInput {
  const channelConfig = resolveChannelConfig(cfg);
  const accountConfig = resolveNormalizedAccountEntry(
    channelConfig?.accounts,
    accountId,
    normalizeAccountId,
  );
  const isDefaultAccount = normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;

  return mergeAccountConfig({
    channelConfig,
    accountConfig,
    omitKeys: ["defaultAccount", ...(isDefaultAccount ? [] : BUZZ_ACCOUNT_OWNED_KEYS)],
  });
}

export function resolveBuzzAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBuzzAccount {
  const requestedAccountId = params.accountId?.trim();
  const accountId = requestedAccountId
    ? normalizeAccountId(requestedAccountId)
    : resolveDefaultBuzzAccountId(params.cfg);
  const channelConfig = resolveChannelConfig(params.cfg);
  const rawConfig = resolveBuzzAccountConfig(params.cfg, accountId);
  const config: BuzzAccountConfig = {
    ...rawConfig,
    groupPolicy: rawConfig.groupPolicy ?? "allowlist",
    groups: normalizeBuzzGroups(rawConfig.groups),
  };
  const allowEnvFallback = accountId === DEFAULT_ACCOUNT_ID;
  const relayUrl =
    config.relayUrl?.trim() ||
    (allowEnvFallback ? process.env.BUZZ_RELAY_URL?.trim() : undefined) ||
    "";
  const privateKey =
    normalizeSecretInputString(config.privateKey) ||
    (allowEnvFallback && config.privateKey === undefined
      ? process.env.BUZZ_PRIVATE_KEY?.trim()
      : undefined) ||
    "";
  const authTag =
    normalizeSecretInputString(config.authTag) ||
    (allowEnvFallback && config.authTag === undefined
      ? process.env.BUZZ_AUTH_TAG?.trim()
      : undefined) ||
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
    enabled: channelConfig?.enabled !== false && config.enabled !== false,
    configured: Boolean(relayUrl && privateKey),
    relayUrl,
    privateKey,
    authTag,
    publicKey,
    config,
  };
}
