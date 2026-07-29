// Matrix plugin module implements credentials read behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import { getOptionalMatrixRuntime } from "../runtime.js";

export { resolveMatrixCredentialsDir, resolveMatrixCredentialsPath } from "../storage-paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type MatrixStoredCredentialRecord = MatrixStoredCredentials & {
  accountId: string;
};

export type MatrixCredentialRevocationRecord = {
  accountId: string;
  kind: "revoked";
  revokedAt: string;
};

export type MatrixCredentialStateRecord =
  | MatrixStoredCredentialRecord
  | MatrixCredentialRevocationRecord;

export const MATRIX_CREDENTIALS_NAMESPACE = "credentials";
export const MATRIX_CREDENTIALS_MAX_ENTRIES = 256;

export function matrixCredentialsStoreKey(accountId?: string | null): string {
  return `account:${normalizeAccountId(accountId)}`;
}

export function normalizeMatrixStoredCredentials(
  value: unknown,
  accountId?: string | null,
): MatrixStoredCredentialRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const parsed = value as Partial<MatrixStoredCredentialRecord>;
  if (
    typeof parsed.homeserver !== "string" ||
    !parsed.homeserver ||
    typeof parsed.userId !== "string" ||
    !parsed.userId ||
    typeof parsed.accessToken !== "string" ||
    !parsed.accessToken ||
    typeof parsed.createdAt !== "string" ||
    !parsed.createdAt
  ) {
    return null;
  }
  const normalizedAccountId = normalizeAccountId(accountId ?? parsed.accountId);
  return {
    accountId: normalizedAccountId,
    homeserver: parsed.homeserver,
    userId: parsed.userId,
    accessToken: parsed.accessToken,
    ...(typeof parsed.deviceId === "string" ? { deviceId: parsed.deviceId } : {}),
    createdAt: parsed.createdAt,
    ...(typeof parsed.lastUsedAt === "string" ? { lastUsedAt: parsed.lastUsedAt } : {}),
  };
}

export function isMatrixCredentialRevocation(
  value: unknown,
  accountId?: string | null,
): value is MatrixCredentialRevocationRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const parsed = value as Partial<MatrixCredentialRevocationRecord>;
  return (
    parsed.kind === "revoked" &&
    typeof parsed.revokedAt === "string" &&
    parsed.revokedAt.length > 0 &&
    normalizeAccountId(parsed.accountId) === normalizeAccountId(accountId ?? parsed.accountId)
  );
}

export function openMatrixCredentialsStore(
  env: NodeJS.ProcessEnv = process.env,
): PluginStateSyncKeyedStore<MatrixCredentialStateRecord> {
  const runtime = getOptionalMatrixRuntime();
  const resolvedEnv =
    env.OPENCLAW_STATE_DIR?.trim() || !runtime
      ? env
      : { ...env, OPENCLAW_STATE_DIR: runtime.state.resolveStateDir(env) };
  return createPluginStateSyncKeyedStore<MatrixCredentialStateRecord>("matrix", {
    namespace: MATRIX_CREDENTIALS_NAMESPACE,
    maxEntries: MATRIX_CREDENTIALS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env: resolvedEnv,
  });
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const normalizedAccountId = normalizeAccountId(accountId);
  const stored = openMatrixCredentialsStore(env).lookup(matrixCredentialsStoreKey(accountId));
  const parsed = normalizeMatrixStoredCredentials(stored, normalizedAccountId);
  if (!parsed || parsed.accountId !== normalizedAccountId) {
    return null;
  }
  const { accountId: _accountId, ...credentials } = parsed;
  return credentials;
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const normalizedAccountId = normalizeAccountId(accountId);
  // Keep a durable revocation marker so doctor cannot resurrect explicitly
  // cleared credentials from a legacy file left by an interrupted migration.
  openMatrixCredentialsStore(env).register(matrixCredentialsStoreKey(normalizedAccountId), {
    accountId: normalizedAccountId,
    kind: "revoked",
    revokedAt: new Date().toISOString(),
  });
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string; accessToken?: string },
): boolean {
  if (!config.userId) {
    if (!config.accessToken) {
      return false;
    }
    return stored.homeserver === config.homeserver && stored.accessToken === config.accessToken;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
