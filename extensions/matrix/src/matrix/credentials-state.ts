// Pure Matrix credential record shapes and normalizers, split from
// credentials-read so the doctor contract closure never loads the sync
// plugin-state store (which pulls the heavy state-db graph via runtime-doctor).
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

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

type MatrixCredentialRevocationRecord = {
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
