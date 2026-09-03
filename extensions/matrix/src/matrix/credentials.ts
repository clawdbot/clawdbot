// Matrix plugin module implements credentials behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { openMatrixCredentialsStore } from "./credentials-read.js";
import {
  isMatrixCredentialRevocation,
  matrixCredentialsStoreKey,
  normalizeMatrixStoredCredentials,
} from "./credentials-state.js";
import type { MatrixStoredCredentialRecord, MatrixStoredCredentials } from "./credentials-state.js";

export {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
} from "./credentials-read.js";
export type { MatrixStoredCredentials } from "./credentials-state.js";

export async function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const normalizedAccountId = normalizeAccountId(accountId);
  const store = openMatrixCredentialsStore(env);
  const now = new Date().toISOString();
  store.update(matrixCredentialsStoreKey(normalizedAccountId), (current) => {
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    return {
      accountId: normalizedAccountId,
      homeserver: credentials.homeserver,
      userId: credentials.userId,
      accessToken: credentials.accessToken,
      ...(typeof credentials.deviceId === "string" ? { deviceId: credentials.deviceId } : {}),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    } satisfies MatrixStoredCredentialRecord;
  });
}

export async function saveBackfilledMatrixDeviceId(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<"saved" | "skipped"> {
  const normalizedAccountId = normalizeAccountId(accountId);
  const store = openMatrixCredentialsStore(env);
  const now = new Date().toISOString();
  let result: "saved" | "skipped" = "saved";
  store.update(matrixCredentialsStoreKey(normalizedAccountId), (current) => {
    // A delayed login backfill must not resurrect credentials after logout.
    if (isMatrixCredentialRevocation(current, normalizedAccountId)) {
      result = "skipped";
      return current;
    }
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    if (
      existing &&
      (existing.homeserver !== credentials.homeserver ||
        existing.userId !== credentials.userId ||
        existing.accessToken !== credentials.accessToken)
    ) {
      result = "skipped";
      return existing;
    }
    return {
      accountId: normalizedAccountId,
      homeserver: credentials.homeserver,
      userId: credentials.userId,
      accessToken: credentials.accessToken,
      ...(typeof credentials.deviceId === "string" ? { deviceId: credentials.deviceId } : {}),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    } satisfies MatrixStoredCredentialRecord;
  });
  return result;
}

export async function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const normalizedAccountId = normalizeAccountId(accountId);
  const store = openMatrixCredentialsStore(env);
  store.update(matrixCredentialsStoreKey(normalizedAccountId), (current) => {
    // A delayed activity touch must preserve an explicit logout tombstone.
    if (isMatrixCredentialRevocation(current, normalizedAccountId)) {
      return current;
    }
    const existing = normalizeMatrixStoredCredentials(current, normalizedAccountId);
    return existing ? { ...existing, lastUsedAt: new Date().toISOString() } : undefined;
  });
}
