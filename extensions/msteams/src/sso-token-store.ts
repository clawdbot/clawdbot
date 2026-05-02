/**
 * File-backed store for Bot Framework OAuth SSO tokens.
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

import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

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
const STORE_KEY_VERSION_PREFIX = "v2:";

function makeKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${Buffer.from(
    JSON.stringify([connectionName, userId]),
    "utf8",
  ).toString("base64url")}`;
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
  const filePath = resolveMSTeamsStorePath({
    filename: STORE_FILENAME,
    env: params?.env,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });

  const empty: SsoStoreData = { version: 1, tokens: {} };

  const readStore = async (): Promise<SsoStoreData> => {
    const { value } = await readJsonFile(filePath, empty);
    if (!isSsoStoreData(value)) {
      return { version: 1, tokens: {} };
    }
    const tokens: Record<string, MSTeamsSsoStoredToken> = {};
    for (const stored of Object.values(value.tokens)) {
      const normalized = normalizeStoredToken(stored);
      if (!normalized) {
        continue;
      }
      tokens[makeKey(normalized.connectionName, normalized.userId)] = normalized;
    }
    return {
      version: 1,
      tokens,
    };
  };

  return {
    async get({ connectionName, userId }) {
      const store = await readStore();
      return store.tokens[makeKey(connectionName, userId)] ?? null;
    },

    async save(token) {
      await withFileLock(filePath, empty, async () => {
        const store = await readStore();
        const key = makeKey(token.connectionName, token.userId);
        store.tokens[key] = { ...token };
        await writeJsonFile(filePath, store);
      });
    },

    async remove({ connectionName, userId }) {
      let removed = false;
      await withFileLock(filePath, empty, async () => {
        const store = await readStore();
        const key = makeKey(connectionName, userId);
        if (store.tokens[key]) {
          delete store.tokens[key];
          removed = true;
          await writeJsonFile(filePath, store);
        }
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
