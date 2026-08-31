import { formatMatrixErrorReason } from "../errors.js";
import type {
  MatrixCryptoBootstrapOptions,
  MatrixCryptoBootstrapResult,
} from "./crypto-bootstrap.js";

export type MatrixOwnDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  // "verified" is intentionally strict: this device must be trusted through the
  // Matrix cross-signing identity chain, not merely signed by the owner key.
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
  recoveryKeyStored: boolean;
  recoveryKeyCreatedAt: string | null;
  recoveryKeyId: string | null;
  backupVersion: string | null;
  backup: MatrixRoomKeyBackupStatus;
  serverDeviceKnown: boolean | null;
};

export type MatrixDeviceVerificationStatus = {
  encryptionEnabled: boolean;
  userId: string | null;
  deviceId: string | null;
  verified: boolean;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
};

export type MatrixRoomKeyBackupStatus = {
  serverVersion: string | null;
  activeVersion: string | null;
  trusted: boolean | null;
  matchesDecryptionKey: boolean | null;
  decryptionKeyCached: boolean | null;
  keyLoadAttempted: boolean;
  keyLoadError: string | null;
};

export const MATRIX_STATUS_DIAGNOSTIC_TIMEOUT_MS = 10_000;
const DEFAULT_MATRIX_LOCAL_TIMEOUT_MS = 60_000;

export function resolveMatrixLocalTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MATRIX_LOCAL_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(raw));
}

export function unresolvedMatrixRoomKeyBackupStatus(): MatrixRoomKeyBackupStatus {
  return {
    serverVersion: null,
    activeVersion: null,
    trusted: null,
    matchesDecryptionKey: null,
    decryptionKeyCached: null,
    keyLoadAttempted: false,
    keyLoadError: null,
  };
}

export function unresolvedMatrixDeviceVerificationStatus(params: {
  userId: string | null;
  deviceId: string | null;
}): MatrixDeviceVerificationStatus {
  return {
    encryptionEnabled: true,
    userId: params.userId,
    deviceId: params.deviceId,
    verified: false,
    localVerified: false,
    crossSigningVerified: false,
    signedByOwner: false,
  };
}

export async function resolveMatrixDiagnostic<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  const result = await resolveMatrixDiagnosticResult(promise, timeoutMs);
  return result.value;
}

export async function resolveMatrixDiagnosticResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ error: unknown; timedOut: boolean; value: T | null }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const guarded = promise
      .then((value) => ({ error: null, timedOut: false, value }))
      .catch((error: unknown) => ({ error, timedOut: false, value: null }));
    const timeout = new Promise<{ error: null; timedOut: true; value: null }>((resolve) => {
      timeoutId = setTimeout(
        () => resolve({ error: null, timedOut: true, value: null }),
        timeoutMs,
      );
      timeoutId.unref?.();
    });
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function isMatrixAccessTokenInvalidatedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    body?: { errcode?: string };
    data?: { errcode?: string };
    statusCode?: number;
  };
  const errcode = err.body?.errcode ?? err.data?.errcode;
  if (err.statusCode === 401 && errcode === "M_UNKNOWN_TOKEN") {
    return true;
  }
  const reason = formatMatrixErrorReason(error);
  return (
    reason.includes("m_unknown_token") ||
    reason.includes("unknown token") ||
    (reason.includes("access token") &&
      (reason.includes("invalid") || reason.includes("unrecognized") || reason.includes("unknown")))
  );
}

export type MatrixRoomKeyBackupRestoreResult = {
  success: boolean;
  error?: string;
  backupVersion: string | null;
  imported: number;
  total: number;
  loadedFromSecretStorage: boolean;
  restoredAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};

export type MatrixRoomKeyBackupResetResult = {
  success: boolean;
  error?: string;
  previousVersion: string | null;
  deletedVersion: string | null;
  createdVersion: string | null;
  resetAt?: string;
  backup: MatrixRoomKeyBackupStatus;
};

export type MatrixRecoveryKeyVerificationResult = MatrixOwnDeviceVerificationStatus & {
  success: boolean;
  recoveryKeyAccepted: boolean;
  backupUsable: boolean;
  deviceOwnerVerified: boolean;
  verifiedAt?: string;
  error?: string;
};

export type MatrixOwnCrossSigningPublicationStatus = {
  userId: string | null;
  masterKeyPublished: boolean;
  selfSigningKeyPublished: boolean;
  userSigningKeyPublished: boolean;
  published: boolean;
};

export type MatrixVerificationBootstrapResult = {
  success: boolean;
  error?: string;
  verification: MatrixOwnDeviceVerificationStatus;
  crossSigning: MatrixOwnCrossSigningPublicationStatus;
  pendingVerifications: number;
  cryptoBootstrap: MatrixCryptoBootstrapResult | null;
};

export const MATRIX_INITIAL_CRYPTO_BOOTSTRAP_OPTIONS = {
  allowAutomaticCrossSigningReset: false,
} satisfies MatrixCryptoBootstrapOptions;

export const MATRIX_AUTOMATIC_REPAIR_BOOTSTRAP_OPTIONS = {
  forceResetCrossSigning: true,
  allowSecretStorageRecreateWithoutRecoveryKey: true,
  strict: true,
} satisfies MatrixCryptoBootstrapOptions;

export function createMatrixExplicitBootstrapOptions(params?: {
  allowAutomaticCrossSigningReset?: boolean;
  forceResetCrossSigning?: boolean;
  strict?: boolean;
}): MatrixCryptoBootstrapOptions {
  return {
    forceResetCrossSigning: params?.forceResetCrossSigning === true,
    allowAutomaticCrossSigningReset: params?.allowAutomaticCrossSigningReset !== false,
    allowSecretStorageRecreateWithoutRecoveryKey: true,
    strict: params?.strict !== false,
  };
}

export type MatrixOwnDeviceInfo = {
  deviceId: string;
  displayName: string | null;
  lastSeenIp: string | null;
  lastSeenTs: number | null;
  current: boolean;
};

export type MatrixRoomKeyBackupResetOptions = {
  rotateRecoveryKey?: boolean;
};

export type MatrixOwnDeviceDeleteResult = {
  currentDeviceId: string | null;
  deletedDeviceIds: string[];
  remainingDevices: MatrixOwnDeviceInfo[];
};
