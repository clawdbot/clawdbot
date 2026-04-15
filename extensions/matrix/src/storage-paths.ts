import crypto from "node:crypto";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function sanitizeMatrixPathSegment(value: string): string {
  const cleaned = normalizeLowercaseStringOrEmpty(value)
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

export function resolveMatrixHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) {
      return sanitizeMatrixPathSegment(url.host);
    }
  } catch {
    // fall through
  }
  return sanitizeMatrixPathSegment(homeserver);
}

export function hashMatrixAccessToken(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export function resolveMatrixCredentialsFilename(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId);
  return normalized === DEFAULT_ACCOUNT_ID ? "credentials.json" : `credentials-${normalized}.json`;
}

export function resolveMatrixCredentialsDir(stateDir: string): string {
  return path.join(stateDir, "credentials", "matrix");
}

export function resolveMatrixCredentialsPath(params: {
  stateDir: string;
  accountId?: string | null;
}): string {
  return path.join(
    resolveMatrixCredentialsDir(params.stateDir),
    resolveMatrixCredentialsFilename(params.accountId),
  );
}

export function resolveMatrixLegacyFlatStoreRoot(stateDir: string): string {
  return path.join(stateDir, "matrix");
}

export function resolveMatrixLegacyFlatStoragePaths(stateDir: string): {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
} {
  const rootDir = resolveMatrixLegacyFlatStoreRoot(stateDir);
  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
  };
}

export function resolveMatrixAccountStorageRoot(params: {
  stateDir: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId?: string | null;
}): {
  rootDir: string;
  accountKey: string;
  tokenHash: string;
} {
  const accountKey = sanitizeMatrixPathSegment(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const userKey = sanitizeMatrixPathSegment(params.userId);
  const serverKey = resolveMatrixHomeserverKey(params.homeserver);
  const tokenHash = hashMatrixAccessToken(params.accessToken);
  return {
    rootDir: path.join(
      params.stateDir,
      "matrix",
      "accounts",
      accountKey,
      `${serverKey}__${userKey}`,
      tokenHash,
    ),
    accountKey,
    tokenHash,
  };
}
