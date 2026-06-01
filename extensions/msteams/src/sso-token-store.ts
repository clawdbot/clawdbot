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
import fs from "node:fs/promises";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile } from "./store-fs.js";

type MSTeamsSsoStoredToken = {
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

export type MSTeamsSsoTokenStore = {
  get(params: { connectionName: string; userId: string }): Promise<MSTeamsSsoStoredToken | null>;
  save(token: MSTeamsSsoStoredToken): Promise<void>;
  remove(params: { connectionName: string; userId: string }): Promise<boolean>;
};

type SsoStoreData = {
  version: 1;
  // Keyed by `${connectionName}::${userId}` for a simple flat map on disk.
  tokens: Record<string, MSTeamsSsoStoredToken>;
};

const STORE_FILENAME = "msteams-sso-tokens.json";
const SSO_TOKENS_NAMESPACE = "sso-tokens";
const SSO_TOKEN_MIGRATIONS_NAMESPACE = "sso-token-migrations";
const SSO_TOKEN_LOCK_FILENAME = "msteams-sso-tokens.sqlite.lock";
const MAX_SSO_TOKENS = 5000;
const STORE_KEY_VERSION_PREFIX = "v2:";

function makeKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${createHash("sha256")
    .update(JSON.stringify([connectionName, userId]))
    .digest("hex")}`;
}

function buildMigrationKey(filePath: string): string {
  return `legacy-json:${createHash("sha256").update(filePath).digest("hex")}`;
}

function buildMigrationContentKey(filePath: string, value: unknown): string {
  return `legacy-json-content:${createHash("sha256")
    .update(filePath)
    .update("\0")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")}`;
}

function createTokenStore(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): PluginStateKeyedStore<MSTeamsSsoStoredToken> {
  return getMSTeamsRuntime().state.openKeyedStore<MSTeamsSsoStoredToken>({
    namespace: SSO_TOKENS_NAMESPACE,
    maxEntries: MAX_SSO_TOKENS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function createMigrationStore(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}): PluginStateKeyedStore<{ importedAt: string }> {
  return getMSTeamsRuntime().state.openKeyedStore<{ importedAt: string }>({
    namespace: SSO_TOKEN_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

function normalizeStoredToken(value: unknown): MSTeamsSsoStoredToken | null {
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

function isSsoStoreData(value: unknown): value is SsoStoreData {
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
  const legacyFilePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
  const empty: SsoStoreData = { version: 1, tokens: {} };
  const tokenStore = createTokenStore(params);
  const migrationStore = createMigrationStore(params);
  const migrationKey = buildMigrationKey(legacyFilePath);
  let legacyImportPromise: Promise<void> | null = null;

  const importLegacyStore = async (): Promise<void> => {
    const imported = (await migrationStore.lookup(migrationKey)) !== undefined;
    const { value, exists } = await readJsonFile<unknown>(legacyFilePath, empty);
    const contentKey = exists ? buildMigrationContentKey(legacyFilePath, value) : null;
    if (contentKey && (await migrationStore.lookup(contentKey))) {
      return;
    }
    if (exists && isSsoStoreData(value)) {
      for (const stored of Object.values(value.tokens)) {
        const normalized = normalizeStoredToken(stored);
        if (!normalized) {
          continue;
        }
        await tokenStore.registerIfAbsent(
          makeKey(normalized.connectionName, normalized.userId),
          toPluginJsonValue(normalized),
        );
      }
    }
    if (contentKey) {
      await migrationStore.register(contentKey, { importedAt: new Date().toISOString() });
    }
    if (!imported) {
      await migrationStore.register(migrationKey, { importedAt: new Date().toISOString() });
    }
    if (exists) {
      await fs.rm(legacyFilePath, { force: true }).catch(() => {});
    }
  };

  const ensureLegacyImported = async (): Promise<void> => {
    if (!legacyImportPromise) {
      legacyImportPromise = withMSTeamsSqliteMutationLock(params, SSO_TOKEN_LOCK_FILENAME, () =>
        importLegacyStore(),
      ).finally(() => {
        legacyImportPromise = null;
      });
    }
    await legacyImportPromise;
  };

  return {
    async get({ connectionName, userId }) {
      await ensureLegacyImported();
      return (await tokenStore.lookup(makeKey(connectionName, userId))) ?? null;
    },

    async save(token) {
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_LOCK_FILENAME, async () => {
        await importLegacyStore();
        await tokenStore.register(
          makeKey(token.connectionName, token.userId),
          toPluginJsonValue({ ...token }),
        );
      });
    },

    async remove({ connectionName, userId }) {
      let removed = false;
      await withMSTeamsSqliteMutationLock(params, SSO_TOKEN_LOCK_FILENAME, async () => {
        await importLegacyStore();
        removed = await tokenStore.delete(makeKey(connectionName, userId));
      });
      return removed;
    },
  };
}

/** In-memory store, primarily useful for tests. */
export function createMSTeamsSsoTokenStoreMemory(): MSTeamsSsoTokenStore {
  const tokens = new Map<string, MSTeamsSsoStoredToken>();
  return {
    async get({ connectionName, userId }) {
      return tokens.get(makeKey(connectionName, userId)) ?? null;
    },
    async save(token) {
      tokens.set(makeKey(token.connectionName, token.userId), { ...token });
    },
    async remove({ connectionName, userId }) {
      return tokens.delete(makeKey(connectionName, userId));
    },
  };
}
