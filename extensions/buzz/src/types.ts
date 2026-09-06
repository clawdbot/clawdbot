import { getPublicKey, nip19 } from "nostr-tools";
import { createAccountListHelpers, mergeAccountConfig } from "openclaw/plugin-sdk/account-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BuzzAccountIdSchema, type BuzzConfig, type BuzzConfigInput } from "./config-schema.js";
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
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  config: BuzzConfig;
}

function resolveChannelConfig(cfg: OpenClawConfig): BuzzConfigInput | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.buzz as BuzzConfigInput | undefined;
}

export const {
  listAccountIds: listBuzzAccountIds,
  resolveDefaultAccountId: resolveDefaultBuzzAccountId,
} = createAccountListHelpers<BuzzConfigInput>("buzz", {
  normalizeAccountId,
  fallbackAccountIdWhenEmpty: false,
  implicitDefaultAccount: {
    channelKeys: ["relayUrl", "privateKey"],
    envVars: ["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY"],
  },
});

export function resolveBuzzAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { accountId: string; config: BuzzConfig; configPath: string; allowEnv: boolean } {
  const requestedId = params.accountId?.trim();
  const accountId = requestedId
    ? normalizeOptionalAccountId(requestedId)
    : resolveDefaultBuzzAccountId(params.cfg);
  if (!accountId || !BuzzAccountIdSchema.safeParse(accountId).success) {
    throw new Error("Buzz account ID must be a valid account key");
  }
  const root = resolveChannelConfig(params.cfg) ?? {};
  const allowEnv =
    accountId === DEFAULT_ACCOUNT_ID && !Object.hasOwn(root.accounts ?? {}, accountId);
  const account = allowEnv ? undefined : root.accounts?.[accountId];
  // Nested accounts own complete identities and room selection; only policy inherits.
  const merged = mergeAccountConfig<BuzzConfigInput>({
    channelConfig: root,
    accountConfig: account,
    omitKeys: [
      "defaultAccount",
      ...(allowEnv ? [] : ["name", "relayUrl", "privateKey", "authTag", "groups", "defaultTo"]),
    ],
  });
  return {
    accountId,
    allowEnv,
    configPath: allowEnv ? "channels.buzz" : `channels.buzz.accounts.${accountId}`,
    config: {
      ...merged,
      groupPolicy: merged.groupPolicy ?? "allowlist",
      enabled: root.enabled !== false && account?.enabled !== false,
      groups: normalizeBuzzGroups(merged.groups),
    },
  };
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

export function resolveBuzzAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedBuzzAccount {
  const { accountId, config, configPath, allowEnv } = resolveBuzzAccountConfig(params);
  const relayUrl =
    config.relayUrl?.trim() || (allowEnv ? process.env.BUZZ_RELAY_URL?.trim() : "") || "";
  const resolveCredential = (field: "privateKey" | "authTag") =>
    resolveSecretInputString({
      value: config[field],
      path: `${configPath}.${field}`,
      mode: "inspect",
    });
  const privateKeyResolution = resolveCredential("privateKey");
  const authTagResolution = resolveCredential("authTag");
  const privateKey =
    privateKeyResolution.value ??
    (allowEnv && privateKeyResolution.status === "missing"
      ? process.env.BUZZ_PRIVATE_KEY?.trim() || ""
      : "");
  const authTag =
    authTagResolution.value ??
    (allowEnv && authTagResolution.status === "missing"
      ? process.env.BUZZ_AUTH_TAG?.trim() || ""
      : "");
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
    configured: Boolean(relayUrl && (privateKey || privateKeyResolution.ref)),
    relayUrl,
    privateKey,
    authTag,
    publicKey,
    tokenStatus:
      privateKeyResolution.ref || authTagResolution.ref
        ? "configured_unavailable"
        : privateKey
          ? "available"
          : "missing",
    config,
  };
}

export function assertBuzzAccountAvailable(account: ResolvedBuzzAccount): void {
  assertSecretOwnerAvailable("account", `buzz:${account.accountId}`);
  if (account.tokenStatus === "configured_unavailable") {
    throw new Error(
      `Buzz credentials for account "${account.accountId}" are configured but unavailable.`,
    );
  }
}
