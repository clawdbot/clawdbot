/**
 * SQLite-backed store for Bot Framework OAuth SSO tokens.
 *
 * Tokens are keyed by (connectionName, userId). `userId` should be the
 * stable AAD object ID (`activity.from.aadObjectId`) when available,
 * falling back to the Bot Framework `activity.from.id`.
 *
 * The store is intentionally minimal: it persists the exchanged user
 * token plus its expiration so consumers (for example tool handlers
 * that call Microsoft Graph with delegated permissions) can fetch a
 * valid token without reaching back into Bot Framework every turn.
 */

import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsAccountStateNamespace,
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

export type MSTeamsSsoStoredToken = {
  /** Channel account that owns this token. */
  accountId?: string;
  /** Connection name from the Bot Framework OAuth connection setting. */
  connectionName: string;
  /** Stable user identifier (AAD object ID preferred). */
  userId: string;
  /** Exchanged user access token. */
  token: string;
  /** Expiration (ISO 8601) when the Bot Framework user token service reports one. */
  expiresAt?: string;
  /** ISO 8601 timestamp for the last successful exchange. */
  updatedAt: string;
};

type MSTeamsSsoTokenStore = {
  get(params: { connectionName: string; userId: string }): Promise<MSTeamsSsoStoredToken | null>;
  save(token: MSTeamsSsoStoredToken): Promise<void>;
  remove(params: { connectionName: string; userId: string }): Promise<boolean>;
};

type SsoStoreData = {
  version: 1;
  // Keyed by `${connectionName}::${userId}` for a simple flat map on disk.
  tokens: Record<string, MSTeamsSsoStoredToken>;
};

type MSTeamsSsoStoreData = SsoStoreData;

export const MSTEAMS_SSO_TOKENS_LEGACY_FILENAME = "msteams-sso-tokens.json";
export const MSTEAMS_SSO_TOKENS_NAMESPACE = "sso-tokens";
const SSO_TOKEN_MUTATION_KEY = "sso-tokens";
export const MSTEAMS_MAX_SSO_TOKENS = 5000;
const STORE_KEY_VERSION_PREFIX = "v2:";

function normalizeSsoAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed || "default";
}

export function makeMSTeamsSsoTokenStoreKey(
  connectionName: string,
  userId: string,
  accountId?: string | null,
): string {
  const normalizedAccountId = normalizeSsoAccountId(accountId);
  return `${STORE_KEY_VERSION_PREFIX}${createHash("sha256")
    .update(
      JSON.stringify(
        normalizedAccountId === "default"
          ? [connectionName, userId]
          : [normalizedAccountId, connectionName, userId],
      ),
    )
    .digest("hex")}`;
}

function createTokenStore(params?: {
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): PluginStateKeyedStore<MSTeamsSsoStoredToken> {
  const accountId = normalizeSsoAccountId(params?.accountId);
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsSsoStoredToken>({
    // Preserve the shipped default namespace while giving each named bot its
    // own eviction quota so a busy account cannot discard another account's tokens.
    namespace: resolveMSTeamsAccountStateNamespace(MSTEAMS_SSO_TOKENS_NAMESPACE, accountId),
    maxEntries: MSTEAMS_MAX_SSO_TOKENS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

export function normalizeMSTeamsSsoStoredToken(value: unknown): MSTeamsSsoStoredToken | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const token = value as Partial<MSTeamsSsoStoredToken>;
  if (
    typeof token.connectionName !== "string" ||
    !token.connectionName ||
    typeof token.userId !== "string" ||
    !token.userId ||
    typeof token.token !== "string" ||
    !token.token ||
    typeof token.updatedAt !== "string" ||
    !token.updatedAt
  ) {
    return null;
  }
  return {
    ...(typeof token.accountId === "string" && token.accountId
      ? { accountId: token.accountId }
      : {}),
    connectionName: token.connectionName,
    userId: token.userId,
    token: token.token,
    ...(typeof token.expiresAt === "string" ? { expiresAt: token.expiresAt } : {}),
    updatedAt: token.updatedAt,
  };
}

export function isMSTeamsSsoStoreData(value: unknown): value is MSTeamsSsoStoreData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return obj.version === 1 && typeof obj.tokens === "object" && obj.tokens !== null;
}

export function createMSTeamsSsoTokenStoreFs(params?: {
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): MSTeamsSsoTokenStore {
  const tokenStore = createTokenStore(params);
  const accountId = normalizeSsoAccountId(params?.accountId);

  return {
    async get({ connectionName, userId }) {
      return (
        (await tokenStore.lookup(makeMSTeamsSsoTokenStoreKey(connectionName, userId, accountId))) ??
        null
      );
    },

    async save(token) {
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_MUTATION_KEY, async () => {
        await tokenStore.register(
          makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId, accountId),
          toPluginJsonValue({
            connectionName: token.connectionName,
            userId: token.userId,
            token: token.token,
            ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
            updatedAt: token.updatedAt,
            ...(accountId === "default" ? {} : { accountId }),
          }),
        );
      });
    },

    async remove({ connectionName, userId }) {
      let removed = false;
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_MUTATION_KEY, async () => {
        removed = await tokenStore.delete(
          makeMSTeamsSsoTokenStoreKey(connectionName, userId, accountId),
        );
      });
      return removed;
    },
  };
}
