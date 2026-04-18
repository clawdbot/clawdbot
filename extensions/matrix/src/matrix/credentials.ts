import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { createAsyncLock, type AsyncLock } from "./async-lock.js";
import { loadMatrixCredentials, resolveMatrixCredentialsPath } from "./credentials-read.js";
import type { MatrixStoredCredentials } from "./credentials-read.js";

export {
  clearMatrixCredentials,
  credentialsMatchConfig,
  loadMatrixCredentials,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
} from "./credentials-read.js";
export type { MatrixStoredCredentials } from "./credentials-read.js";

const credentialWriteLocks = new Map<string, AsyncLock>();

function withCredentialWriteLock<T>(credPath: string, fn: () => Promise<T>): Promise<T> {
  let withLock = credentialWriteLocks.get(credPath);
  if (!withLock) {
    withLock = createAsyncLock();
    credentialWriteLocks.set(credPath, withLock);
  }
  return withLock(fn);
}

async function writeMatrixCredentialsUnlocked(params: {
  credPath: string;
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">;
  existing: MatrixStoredCredentials | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const toSave: MatrixStoredCredentials = {
    ...params.credentials,
    createdAt: params.existing?.createdAt ?? now,
    lastUsedAt: now,
  };
  await writeJsonFileAtomically(params.credPath, toSave);
}

export async function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  await withCredentialWriteLock(credPath, async () => {
    await writeMatrixCredentialsUnlocked({
      credPath,
      credentials,
      existing: loadMatrixCredentials(env, accountId),
    });
  });
}

export async function saveBackfilledMatrixDeviceId(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<"saved" | "skipped"> {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  return await withCredentialWriteLock(credPath, async () => {
    const existing = loadMatrixCredentials(env, accountId);
    if (
      existing &&
      (existing.homeserver !== credentials.homeserver ||
        existing.userId !== credentials.userId ||
        existing.accessToken !== credentials.accessToken)
    ) {
      return "skipped";
    }

    await writeMatrixCredentialsUnlocked({
      credPath,
      credentials,
      existing,
    });
    return "saved";
  });
}

export async function touchMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<void> {
  const credPath = resolveMatrixCredentialsPath(env, accountId);
  await withCredentialWriteLock(credPath, async () => {
    const existing = loadMatrixCredentials(env, accountId);
    if (!existing) {
      return;
    }

    existing.lastUsedAt = new Date().toISOString();
    await writeJsonFileAtomically(credPath, existing);
  });
}
