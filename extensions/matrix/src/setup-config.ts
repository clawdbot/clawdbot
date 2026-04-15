import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeSecretInputString,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveMatrixEnvAuthReadiness } from "./matrix/client/env-auth.js";
import { updateMatrixAccountConfig } from "./matrix/config-update.js";
import { isSupportedMatrixAvatarSource } from "./matrix/profile.js";
import {
  matrixNamedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget,
  matrixSingleAccountKeysToMove,
} from "./setup-contract.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "name",
  "enabled",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);
const MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set<string>(matrixSingleAccountKeysToMove);
const MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS = new Set<string>(matrixNamedAccountPromotionKeys);

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function resolveSetupAvatarUrl(input: ChannelSetupInput): string | undefined {
  const avatarUrl = input.avatarUrl;
  if (typeof avatarUrl !== "string") {
    return undefined;
  }
  const trimmed = avatarUrl.trim();
  return trimmed || undefined;
}

function resolveExistingMatrixAccountKey(
  accounts: Record<string, Record<string, unknown>>,
  targetAccountId: string,
): string {
  const normalizedTargetAccountId = normalizeAccountId(targetAccountId);
  return (
    Object.keys(accounts).find(
      (accountId) => normalizeAccountId(accountId) === normalizedTargetAccountId,
    ) ?? targetAccountId
  );
}

export function moveSingleMatrixAccountConfigToNamedAccount(cfg: CoreConfig): CoreConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[channel];
  const base =
    typeof baseConfig === "object" && baseConfig
      ? (baseConfig as Record<string, unknown>)
      : undefined;
  if (!base) {
    return cfg;
  }

  const accounts =
    typeof base.accounts === "object" && base.accounts
      ? (base.accounts as Record<string, Record<string, unknown>>)
      : {};
  const hasNamedAccounts = Object.keys(accounts).filter(Boolean).length > 0;
  const keysToMove = Object.entries(base)
    .filter(([key, value]) => {
      if (key === "accounts" || key === "enabled" || value === undefined) {
        return false;
      }
      if (
        !COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key) &&
        !MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key)
      ) {
        return false;
      }
      if (hasNamedAccounts && !MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS.has(key)) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
  if (keysToMove.length === 0) {
    return cfg;
  }

  const targetAccountId = resolveSingleAccountPromotionTarget({ channel: base });
  const resolvedTargetAccountId = resolveExistingMatrixAccountKey(accounts, targetAccountId);

  const nextAccount: Record<string, unknown> = { ...accounts[resolvedTargetAccountId] };
  for (const key of keysToMove) {
    nextAccount[key] = cloneIfObject(base[key]);
  }
  const nextChannel = { ...base };
  for (const key of keysToMove) {
    delete nextChannel[key];
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...nextChannel,
        accounts: {
          ...accounts,
          [resolvedTargetAccountId]: nextAccount,
        },
      },
    },
  };
}

export function validateMatrixSetupInput(params: {
  accountId: string;
  input: ChannelSetupInput;
}): string | null {
  const avatarUrl = resolveSetupAvatarUrl(params.input);
  if (avatarUrl && !isSupportedMatrixAvatarSource(avatarUrl)) {
    return "Matrix avatar URL must be an mxc:// URI or an http(s) URL.";
  }
  if (params.input.useEnv) {
    const envReadiness = resolveMatrixEnvAuthReadiness(params.accountId, process.env);
    return envReadiness.ready ? null : envReadiness.missingMessage;
  }
  if (!params.input.homeserver?.trim()) {
    return "Matrix requires --homeserver";
  }
  const accessToken = params.input.accessToken?.trim();
  const password = normalizeSecretInputString(params.input.password);
  const userId = params.input.userId?.trim();
  if (!accessToken && !password) {
    return "Matrix requires --access-token or --password";
  }
  if (!accessToken) {
    if (!userId) {
      return "Matrix requires --user-id when using --password";
    }
    if (!password) {
      return "Matrix requires --password when using --user-id";
    }
  }
  return null;
}

export function applyMatrixSetupAccountConfig(params: {
  cfg: CoreConfig;
  accountId: string;
  input: ChannelSetupInput;
}): CoreConfig {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const migratedCfg =
    normalizedAccountId !== DEFAULT_ACCOUNT_ID
      ? moveSingleMatrixAccountConfigToNamedAccount(params.cfg)
      : params.cfg;
  const next = applyAccountNameToChannelSection({
    cfg: migratedCfg,
    channelKey: channel,
    accountId: normalizedAccountId,
    name: params.input.name,
  }) as CoreConfig;
  const avatarUrl = resolveSetupAvatarUrl(params.input);

  if (params.input.useEnv) {
    return updateMatrixAccountConfig(next, normalizedAccountId, {
      enabled: true,
      homeserver: null,
      allowPrivateNetwork: null,
      proxy: null,
      userId: null,
      accessToken: null,
      password: null,
      deviceId: null,
      deviceName: null,
      avatarUrl,
    });
  }

  const accessToken = params.input.accessToken?.trim();
  const password = normalizeSecretInputString(params.input.password);
  const userId = params.input.userId?.trim();
  return updateMatrixAccountConfig(next, normalizedAccountId, {
    enabled: true,
    homeserver: params.input.homeserver?.trim(),
    allowPrivateNetwork:
      typeof params.input.dangerouslyAllowPrivateNetwork === "boolean"
        ? params.input.dangerouslyAllowPrivateNetwork
        : typeof params.input.allowPrivateNetwork === "boolean"
          ? params.input.allowPrivateNetwork
          : undefined,
    proxy: normalizeOptionalString(params.input.proxy),
    userId: password && !userId ? null : userId,
    accessToken: accessToken || (password ? null : undefined),
    password: password || (accessToken ? null : undefined),
    deviceName: params.input.deviceName?.trim(),
    avatarUrl,
    initialSyncLimit: params.input.initialSyncLimit,
  });
}
