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
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

export type MSTeamsSsoStoredToken = {
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
  save(value: MSTeamsSsoStoredToken): Promise<void>;
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
const SSO_TOKEN_LOCK_FILENAME = "msteams-sso-tokens.sqlite.lock";
export const MSTEAMS_MAX_SSO_TOKENS = 5000;
const STORE_KEY_VERSION_PREFIX = "v2:";

export function makeMSTeamsSsoTokenStoreKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${createHash("sha256")
    .update(JSON.stringify([connectionName, userId]))
    .digest("hex")}`;
}

function createTokenStore(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): PluginStateKeyedStore<MSTeamsSsoStoredToken> {
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsSsoStoredToken>({
    namespace: MSTEAMS_SSO_TOKENS_NAMESPACE,
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
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): MSTeamsSsoTokenStore {
  const tokenStore = createTokenStore(params);

  return {
    async get({ connectionName, userId }) {
      return (await tokenStore.lookup(makeMSTeamsSsoTokenStoreKey(connectionName, userId))) ?? null;
    },

    async save(token) {
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_LOCK_FILENAME, async () => {
        await tokenStore.register(
          makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId),
          toPluginJsonValue({ ...token }),
        );
      });
    },

    async remove({ connectionName, userId }) {
      let removed = false;
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_LOCK_FILENAME, async () => {
        removed = await tokenStore.delete(makeMSTeamsSsoTokenStoreKey(connectionName, userId));
      });
      return removed;
    },
  };
}
