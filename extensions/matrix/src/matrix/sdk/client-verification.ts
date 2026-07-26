import { normalizeNullableString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMatrixErrorMessage } from "../errors.js";
import { loadMatrixCryptoRuntime } from "./client-base.js";
import { MatrixClientCore } from "./client-core.js";
import {
  MATRIX_STATUS_DIAGNOSTIC_TIMEOUT_MS,
  isMatrixAccessTokenInvalidatedError,
  resolveMatrixDiagnostic,
  resolveMatrixDiagnosticResult,
  unresolvedMatrixDeviceVerificationStatus,
  unresolvedMatrixRoomKeyBackupStatus,
  type MatrixDeviceVerificationStatus,
  type MatrixOwnDeviceVerificationStatus,
  type MatrixRoomKeyBackupStatus,
} from "./client-support.js";
import { LogService } from "./logger.js";
import { isRepairableSecretStorageAccessError } from "./recovery-key-store.js";
import type { MatrixCryptoBootstrapApi, MatrixDeviceVerificationStatusLike } from "./types.js";

const normalizeOptionalString = normalizeNullableString;

export abstract class MatrixClientVerification extends MatrixClientCore {
  async getRoomKeyBackupStatus(): Promise<MatrixRoomKeyBackupStatus> {
    if (!this.encryptionEnabled) {
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

    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    const serverVersionFallback = await this.resolveRoomKeyBackupVersion();
    if (!crypto) {
      return {
        serverVersion: serverVersionFallback,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
        keyLoadAttempted: false,
        keyLoadError: null,
      };
    }

    let { activeVersion, decryptionKeyCached } = await this.resolveRoomKeyBackupLocalState(crypto);
    let { serverVersion, trusted, matchesDecryptionKey } =
      await this.resolveRoomKeyBackupTrustState(crypto, serverVersionFallback);
    const shouldLoadBackupKey =
      Boolean(serverVersion) && (decryptionKeyCached === false || matchesDecryptionKey === false);
    const shouldActivateBackup = Boolean(serverVersion) && !activeVersion;
    let keyLoadAttempted = false;
    let keyLoadError: string | null = null;
    if (serverVersion && (shouldLoadBackupKey || shouldActivateBackup)) {
      if (shouldLoadBackupKey) {
        if (
          typeof crypto.loadSessionBackupPrivateKeyFromSecretStorage ===
          "function" /* pragma: allowlist secret */
        ) {
          keyLoadAttempted = true;
          try {
            await crypto.loadSessionBackupPrivateKeyFromSecretStorage(); // pragma: allowlist secret
          } catch (err) {
            keyLoadError = formatMatrixErrorMessage(err);
          }
        } else {
          keyLoadError =
            "Matrix crypto backend does not support loading backup keys from secret storage";
        }
      }
      if (!keyLoadError) {
        await this.enableTrustedRoomKeyBackupIfPossible(crypto);
      }
      ({ activeVersion, decryptionKeyCached } = await this.resolveRoomKeyBackupLocalState(crypto));
      ({ serverVersion, trusted, matchesDecryptionKey } = await this.resolveRoomKeyBackupTrustState(
        crypto,
        serverVersion,
      ));
    }

    return {
      serverVersion,
      activeVersion,
      trusted,
      matchesDecryptionKey,
      decryptionKeyCached,
      keyLoadAttempted,
      keyLoadError,
    };
  }

  async getDeviceVerificationStatus(
    userId: string | null | undefined,
    deviceId: string | null | undefined,
  ): Promise<MatrixDeviceVerificationStatus> {
    const normalizedUserId = userId?.trim() || null;
    const normalizedDeviceId = deviceId?.trim() || null;
    if (!this.encryptionEnabled) {
      return {
        encryptionEnabled: false,
        userId: normalizedUserId,
        deviceId: normalizedDeviceId,
        verified: false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
      };
    }

    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    let deviceStatus: MatrixDeviceVerificationStatusLike | null = null;
    if (
      crypto &&
      normalizedUserId &&
      normalizedDeviceId &&
      typeof crypto.getDeviceVerificationStatus === "function"
    ) {
      deviceStatus = await crypto
        .getDeviceVerificationStatus(normalizedUserId, normalizedDeviceId)
        .catch(() => null);
    }
    const { isMatrixDeviceVerifiedInCurrentClient } = await loadMatrixCryptoRuntime();

    return {
      encryptionEnabled: true,
      userId: normalizedUserId,
      deviceId: normalizedDeviceId,
      verified: isMatrixDeviceVerifiedInCurrentClient(deviceStatus),
      localVerified: deviceStatus?.localVerified === true,
      crossSigningVerified: deviceStatus?.crossSigningVerified === true,
      signedByOwner: deviceStatus?.signedByOwner === true,
    };
  }

  async getOwnDeviceVerificationStatus(): Promise<MatrixOwnDeviceVerificationStatus> {
    const recoveryKey = this.recoveryKeyStore.getRecoveryKeySummary();
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    const deviceId = this.client.getDeviceId()?.trim() || null;
    const diagnosticTimeoutMs = Math.min(this.localTimeoutMs, MATRIX_STATUS_DIAGNOSTIC_TIMEOUT_MS);
    const [backup, deviceVerification, ownDevices] = await Promise.all([
      resolveMatrixDiagnostic(this.getRoomKeyBackupStatus(), diagnosticTimeoutMs),
      resolveMatrixDiagnostic(
        this.getDeviceVerificationStatus(userId, deviceId),
        diagnosticTimeoutMs,
      ),
      resolveMatrixDiagnosticResult(this.listOwnDevices(), diagnosticTimeoutMs),
    ]);
    const resolvedBackup = backup ?? unresolvedMatrixRoomKeyBackupStatus();
    const resolvedDeviceVerification =
      deviceVerification ?? unresolvedMatrixDeviceVerificationStatus({ userId, deviceId });
    const serverDeviceKnown = deviceId
      ? ownDevices.value
        ? ownDevices.value.some((device) => device.deviceId === deviceId)
        : isMatrixAccessTokenInvalidatedError(ownDevices.error)
          ? false
          : null
      : null;

    return {
      ...resolvedDeviceVerification,
      verified: resolvedDeviceVerification.crossSigningVerified,
      recoveryKeyStored: Boolean(recoveryKey),
      recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
      recoveryKeyId: recoveryKey?.keyId ?? null,
      backupVersion: resolvedBackup.serverVersion,
      backup: resolvedBackup,
      serverDeviceKnown,
    };
  }

  async getOwnDeviceIdentityVerificationStatus(): Promise<MatrixDeviceVerificationStatus> {
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    const deviceId = this.client.getDeviceId()?.trim() || null;
    const deviceVerification = await this.getDeviceVerificationStatus(userId, deviceId);
    return {
      ...deviceVerification,
      verified: deviceVerification.crossSigningVerified,
    };
  }

  async trustOwnIdentityAfterSelfVerification(): Promise<void> {
    if (!this.encryptionEnabled) {
      return;
    }

    await this.ensureStartedForCryptoControlPlane();
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    const ownIdentity =
      crypto && typeof crypto.getOwnIdentity === "function"
        ? await crypto.getOwnIdentity().catch(() => undefined)
        : undefined;
    if (!ownIdentity) {
      return;
    }

    try {
      if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) {
        return;
      }
      if (typeof ownIdentity.verify !== "function") {
        return;
      }
      await ownIdentity.verify();
    } finally {
      ownIdentity.free?.();
    }
  }

  protected async resolveActiveRoomKeyBackupVersion(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<string | null> {
    if (typeof crypto.getActiveSessionBackupVersion !== "function") {
      return null;
    }
    const version = await crypto.getActiveSessionBackupVersion().catch(() => null);
    return normalizeOptionalString(version);
  }

  protected async resolveCachedRoomKeyBackupDecryptionKey(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<boolean | null> {
    const read = Reflect.get(crypto, "getSessionBackupPrivateKey"); // pragma: allowlist secret
    if (typeof read !== "function") {
      return null;
    }
    const key = await read.call(crypto).catch(() => null); // pragma: allowlist secret
    return key ? key.length > 0 : false;
  }

  protected async resolveRoomKeyBackupLocalState(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<{ activeVersion: string | null; decryptionKeyCached: boolean | null }> {
    const [activeVersion, decryptionKeyCached] = await Promise.all([
      this.resolveActiveRoomKeyBackupVersion(crypto),
      this.resolveCachedRoomKeyBackupDecryptionKey(crypto),
    ]);
    return { activeVersion, decryptionKeyCached };
  }

  protected async shouldForceSecretStorageRecreationForBackupReset(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<boolean> {
    const decryptionKeyCached = await this.resolveCachedRoomKeyBackupDecryptionKey(crypto);
    if (decryptionKeyCached !== false) {
      return false;
    }
    const loadSessionBackupPrivateKeyFromSecretStorage =
      crypto.loadSessionBackupPrivateKeyFromSecretStorage; // pragma: allowlist secret
    if (typeof loadSessionBackupPrivateKeyFromSecretStorage !== "function") {
      return false;
    }
    try {
      await loadSessionBackupPrivateKeyFromSecretStorage.call(crypto); // pragma: allowlist secret
      return false;
    } catch (err) {
      return isRepairableSecretStorageAccessError(err);
    }
  }

  protected async resolveRoomKeyBackupTrustState(
    crypto: MatrixCryptoBootstrapApi,
    fallbackVersion: string | null,
  ): Promise<{
    serverVersion: string | null;
    trusted: boolean | null;
    matchesDecryptionKey: boolean | null;
  }> {
    let serverVersion = fallbackVersion;
    let trusted: boolean | null = null;
    let matchesDecryptionKey: boolean | null = null;
    if (typeof crypto.getKeyBackupInfo === "function") {
      const info = await crypto.getKeyBackupInfo().catch(() => null);
      serverVersion = normalizeOptionalString(info?.version) ?? serverVersion;
      if (info && typeof crypto.isKeyBackupTrusted === "function") {
        const trustInfo = await crypto.isKeyBackupTrusted(info).catch(() => null);
        trusted = typeof trustInfo?.trusted === "boolean" ? trustInfo.trusted : null;
        matchesDecryptionKey =
          typeof trustInfo?.matchesDecryptionKey === "boolean"
            ? trustInfo.matchesDecryptionKey
            : null;
      }
    }
    return { serverVersion, trusted, matchesDecryptionKey };
  }

  protected async resolveDefaultSecretStorageKeyId(
    crypto: MatrixCryptoBootstrapApi | undefined,
  ): Promise<string | null | undefined> {
    const getSecretStorageStatus = crypto?.getSecretStorageStatus; // pragma: allowlist secret
    if (typeof getSecretStorageStatus !== "function") {
      return undefined;
    }
    const status = await getSecretStorageStatus.call(crypto).catch(() => null); // pragma: allowlist secret
    return status?.defaultKeyId;
  }

  protected async resolveRoomKeyBackupVersion(): Promise<string | null> {
    try {
      const response = (await this.doRequest("GET", "/_matrix/client/v3/room_keys/version")) as {
        version?: string;
      };
      return normalizeOptionalString(response.version);
    } catch {
      return null;
    }
  }

  protected async enableTrustedRoomKeyBackupIfPossible(
    crypto: MatrixCryptoBootstrapApi,
  ): Promise<void> {
    if (typeof crypto.checkKeyBackupAndEnable !== "function") {
      return;
    }
    await crypto.checkKeyBackupAndEnable();
  }

  protected async ensureRoomKeyBackupEnabled(crypto: MatrixCryptoBootstrapApi): Promise<void> {
    const existingVersion = await this.resolveRoomKeyBackupVersion();
    if (existingVersion) {
      return;
    }
    LogService.info(
      "MatrixClientLite",
      "No room key backup version found on server, creating one via secret storage bootstrap",
    );
    // matrix-js-sdk 41.3.0 can log transient PerSessionKeyBackupDownloader
    // diagnostics while setupNewKeyBackup creates the first backup, including
    // "Got current backup version from server: undefined" and
    // "Unsupported algorithm undefined". This is an expected upstream
    // matrix-js-sdk race: resetKeyBackup emits key-backup cache events before
    // its async checkKeyBackupAndEnable pass has populated active backup state.
    // Keep the explicit server re-check below and do not hide the SDK logs; if
    // this needs fixing in code, upstream a minimal Matrix SDK repro instead of
    // patching here.
    await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
      setupNewKeyBackup: true,
    });
    const createdVersion = await this.resolveRoomKeyBackupVersion();
    if (!createdVersion) {
      throw new Error("Matrix room key backup is still missing after bootstrap");
    }
    LogService.info("MatrixClientLite", `Room key backup enabled (version ${createdVersion})`);
  }
}
