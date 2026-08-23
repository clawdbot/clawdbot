// Matrix plugin module implements sdk behavior.
import type { Room } from "matrix-js-sdk/lib/models/room.js";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixRoomKeyBackupReadinessError } from "./backup-health.js";
import { isMatrixNotFoundError } from "./errors.js";
import {
  listMatrixOwnDevices,
  resolveMatrixCrossSigningPublicationStatus,
} from "./sdk/client-device-info.js";
import {
  emitMatrixMembershipForRoom,
  refreshMatrixDmRoomIds,
  registerMatrixClientBridge,
} from "./sdk/client-event-bridge.js";
import {
  createMatrixExplicitBootstrapOptions,
  type MatrixOwnCrossSigningPublicationStatus,
  type MatrixOwnDeviceDeleteResult,
  type MatrixOwnDeviceInfo,
  type MatrixRecoveryKeyVerificationResult,
  type MatrixRoomKeyBackupResetOptions,
  type MatrixRoomKeyBackupResetResult,
  type MatrixRoomKeyBackupRestoreResult,
  type MatrixVerificationBootstrapResult,
} from "./sdk/client-support.js";
import { MatrixClientVerification } from "./sdk/client-verification.js";
import type { MatrixCryptoBootstrapResult } from "./sdk/crypto-bootstrap.js";
import { ConsoleLogger, LogService } from "./sdk/logger.js";
import type { MatrixCryptoBootstrapApi } from "./sdk/types.js";

export { ConsoleLogger, LogService };
export type {
  MatrixDeviceVerificationStatus,
  MatrixOwnDeviceDeleteResult,
  MatrixOwnDeviceInfo,
  MatrixOwnDeviceVerificationStatus,
  MatrixRecoveryKeyVerificationResult,
  MatrixRoomKeyBackupResetResult,
  MatrixRoomKeyBackupRestoreResult,
  MatrixRoomKeyBackupStatus,
  MatrixVerificationBootstrapResult,
} from "./sdk/client-support.js";
export type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  LocationMessageEventContent,
  MatrixRawEvent,
  MessageEventContent,
  TextualMessageEventContent,
  TimedFileInfo,
  VideoFileInfo,
} from "./sdk/types.js";

export class MatrixClient extends MatrixClientVerification {
  async verifyWithRecoveryKey(
    rawRecoveryKey: string,
  ): Promise<MatrixRecoveryKeyVerificationResult> {
    const fail = async (
      error: string,
      fields: Partial<
        Pick<
          MatrixRecoveryKeyVerificationResult,
          "backupUsable" | "deviceOwnerVerified" | "recoveryKeyAccepted"
        >
      > = {},
    ): Promise<MatrixRecoveryKeyVerificationResult> => {
      const status = await this.getOwnDeviceVerificationStatus();
      return {
        success: false,
        recoveryKeyAccepted: fields.recoveryKeyAccepted ?? false,
        backupUsable: fields.backupUsable ?? false,
        deviceOwnerVerified: fields.deviceOwnerVerified ?? status.verified,
        error,
        ...status,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    await this.ensureCryptoSupportInitialized();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    const backupUsableBeforeStagedRecovery =
      resolveMatrixRoomKeyBackupReadinessError(await this.getRoomKeyBackupStatus(), {
        requireServerBackup: true,
      }) === null;
    const trimmedRecoveryKey = rawRecoveryKey.trim();
    if (!trimmedRecoveryKey) {
      return await fail("Matrix recovery key is required");
    }

    let stagedKeyId: string | null;
    try {
      stagedKeyId = (await this.resolveDefaultSecretStorageKeyId(crypto)) ?? null;
      this.recoveryKeyStore.stageEncodedRecoveryKey({
        encodedPrivateKey: trimmedRecoveryKey,
        keyId: stagedKeyId,
      });
    } catch (err) {
      return await fail(formatErrorMessage(err));
    }

    const storedRecoveryKeyMatches =
      this.recoveryKeyStore.getRecoveryKeySummary()?.encodedPrivateKey?.trim() ===
      trimmedRecoveryKey;
    if (backupUsableBeforeStagedRecovery && storedRecoveryKeyMatches) {
      const status = await this.getOwnDeviceVerificationStatus();
      const backupUsable =
        resolveMatrixRoomKeyBackupReadinessError(status.backup, {
          requireServerBackup: true,
        }) === null;
      const backupError = resolveMatrixRoomKeyBackupReadinessError(status.backup, {
        requireServerBackup: false,
      });
      const recoveryKeyAccepted = backupUsable;
      if (!status.verified) {
        if (recoveryKeyAccepted) {
          this.recoveryKeyStore.commitStagedRecoveryKey({
            keyId: stagedKeyId,
          });
        } else {
          this.recoveryKeyStore.discardStagedRecoveryKey();
        }
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: false,
          error:
            "Matrix recovery key was applied, but this device still lacks full Matrix identity trust. The recovery key can unlock usable backup material only when 'Backup usable' is yes; full identity trust still requires Matrix cross-signing verification.",
          ...status,
        };
      }
      if (backupError) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: true,
          error: backupError,
          ...status,
        };
      }
      this.recoveryKeyStore.commitStagedRecoveryKey({
        keyId: stagedKeyId,
      });
      return {
        success: true,
        recoveryKeyAccepted: true,
        backupUsable,
        deviceOwnerVerified: true,
        verifiedAt: new Date().toISOString(),
        ...status,
      };
    }

    try {
      const cryptoBootstrapper = this.cryptoBootstrapper;
      if (!cryptoBootstrapper) {
        return await fail("Matrix crypto bootstrapper is not available");
      }
      await cryptoBootstrapper.bootstrap(crypto, {
        allowAutomaticCrossSigningReset: false,
      });
      await this.enableTrustedRoomKeyBackupIfPossible(crypto);
      const status = await this.getOwnDeviceVerificationStatus();
      const backupError = resolveMatrixRoomKeyBackupReadinessError(status.backup, {
        requireServerBackup: false,
      });
      const backupUsable =
        resolveMatrixRoomKeyBackupReadinessError(status.backup, {
          requireServerBackup: true,
        }) === null;
      const stagedRecoveryKeyUsed = this.recoveryKeyStore.hasStagedRecoveryKeyBeenUsed();
      const secretStorageStatus =
        typeof crypto.getSecretStorageStatus === "function"
          ? await crypto.getSecretStorageStatus().catch(() => null)
          : null;
      const stagedRecoveryKeyConfirmedBySecretStorage =
        Boolean(stagedKeyId) &&
        secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === true;
      const stagedRecoveryKeyRejectedBySecretStorage =
        Boolean(stagedKeyId) &&
        secretStorageStatus?.secretStorageKeyValidityMap?.[stagedKeyId ?? ""] === false;
      const stagedRecoveryKeyUnlockedBackup =
        stagedRecoveryKeyUsed &&
        !stagedRecoveryKeyRejectedBySecretStorage &&
        !stagedRecoveryKeyConfirmedBySecretStorage &&
        !backupUsableBeforeStagedRecovery &&
        backupUsable;
      const stagedRecoveryKeyValidated =
        (stagedRecoveryKeyUsed &&
          (stagedRecoveryKeyConfirmedBySecretStorage || stagedRecoveryKeyUnlockedBackup)) ||
        (storedRecoveryKeyMatches && backupUsable);
      const recoveryKeyAccepted = stagedRecoveryKeyValidated && (status.verified || backupUsable);
      if (!status.verified) {
        if (backupUsable && stagedRecoveryKeyValidated) {
          this.recoveryKeyStore.commitStagedRecoveryKey({
            keyId: stagedKeyId,
          });
        } else {
          this.recoveryKeyStore.discardStagedRecoveryKey();
        }
        const committedStatus = recoveryKeyAccepted
          ? await this.getOwnDeviceVerificationStatus()
          : status;
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: false,
          error:
            "Matrix recovery key was applied, but this device still lacks full Matrix identity trust. The recovery key can unlock usable backup material only when 'Backup usable' is yes; full identity trust still requires Matrix cross-signing verification.",
          ...committedStatus,
        };
      }
      if (backupError) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return {
          success: false,
          recoveryKeyAccepted,
          backupUsable,
          deviceOwnerVerified: true,
          error: backupError,
          ...status,
        };
      }
      if (!stagedRecoveryKeyValidated) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return {
          success: false,
          recoveryKeyAccepted: false,
          backupUsable,
          deviceOwnerVerified: true,
          error:
            "Matrix recovery key could not be verified against active Matrix backup material; existing backup may be usable from previously loaded recovery material.",
          ...status,
        };
      }

      this.recoveryKeyStore.commitStagedRecoveryKey({
        keyId: stagedKeyId,
      });
      const committedStatus = await this.getOwnDeviceVerificationStatus();
      return {
        success: true,
        recoveryKeyAccepted: true,
        backupUsable,
        deviceOwnerVerified: true,
        verifiedAt: new Date().toISOString(),
        ...committedStatus,
      };
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      return await fail(formatErrorMessage(err));
    }
  }

  async restoreRoomKeyBackup(
    params: {
      recoveryKey?: string;
    } = {},
  ): Promise<MatrixRoomKeyBackupRestoreResult> {
    let loadedFromSecretStorage = false;
    const fail = async (error: string): Promise<MatrixRoomKeyBackupRestoreResult> => {
      const backup = await this.getRoomKeyBackupStatus();
      return {
        success: false,
        error,
        backupVersion: backup.serverVersion,
        imported: 0,
        total: 0,
        loadedFromSecretStorage,
        backup,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    try {
      const rawRecoveryKey = params.recoveryKey?.trim();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.stageEncodedRecoveryKey({
          encodedPrivateKey: rawRecoveryKey,
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }

      const backup = await this.getRoomKeyBackupStatus();
      loadedFromSecretStorage = backup.keyLoadAttempted && !backup.keyLoadError;
      const backupError = resolveMatrixRoomKeyBackupReadinessError(backup, {
        allowUntrustedMatchingKey: true,
        requireServerBackup: true,
      });
      if (backupError) {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return await fail(backupError);
      }
      if (typeof crypto.restoreKeyBackup !== "function") {
        this.recoveryKeyStore.discardStagedRecoveryKey();
        return await fail("Matrix crypto backend does not support full key backup restore");
      }

      const restore = await crypto.restoreKeyBackup();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.commitStagedRecoveryKey({
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }
      const finalBackup = await this.getRoomKeyBackupStatus();
      return {
        success: true,
        backupVersion: backup.serverVersion,
        imported: typeof restore.imported === "number" ? restore.imported : 0,
        total: typeof restore.total === "number" ? restore.total : 0,
        loadedFromSecretStorage,
        restoredAt: new Date().toISOString(),
        backup: finalBackup,
      };
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      return await fail(formatErrorMessage(err));
    }
  }

  async resetRoomKeyBackup(
    options: MatrixRoomKeyBackupResetOptions = {},
  ): Promise<MatrixRoomKeyBackupResetResult> {
    let previousVersion: string | null = null;
    let deletedVersion: string | null = null;
    const fail = async (error: string): Promise<MatrixRoomKeyBackupResetResult> => {
      const backup = await this.getRoomKeyBackupStatus();
      return {
        success: false,
        error,
        previousVersion,
        deletedVersion,
        createdVersion: backup.serverVersion,
        backup,
      };
    };

    if (!this.encryptionEnabled) {
      return await fail("Matrix encryption is disabled for this client");
    }

    await this.ensureStartedForCryptoControlPlane();
    const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
    if (!crypto) {
      return await fail("Matrix crypto is not available (start client with encryption enabled)");
    }

    previousVersion = await this.resolveRoomKeyBackupVersion();

    // Probe backup-secret access directly before reset. This keeps the reset preflight
    // focused on durable secret-storage health instead of the broader backup status flow,
    // and still catches stale SSSS/recovery-key state even when the server backup is gone.
    const forceNewSecretStorage =
      options.rotateRecoveryKey === true ||
      (await this.shouldForceSecretStorageRecreationForBackupReset(crypto));

    try {
      if (previousVersion) {
        try {
          await this.doRequest(
            "DELETE",
            `/_matrix/client/v3/room_keys/version/${encodeURIComponent(previousVersion)}`,
          );
        } catch (err) {
          if (!isMatrixNotFoundError(err)) {
            throw err;
          }
        }
        deletedVersion = previousVersion;
      }

      await this.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
        setupNewKeyBackup: true,
        // Force SSSS recreation when the existing SSSS key is broken (bad MAC), so
        // the new backup key is written into a fresh SSSS consistent with recovery_key.json.
        forceNewSecretStorage,
        forceNewRecoveryKey: options.rotateRecoveryKey === true,
        // Also allow recreation if bootstrapSecretStorage itself surfaces a repairable
        // error (e.g. bad MAC from a different SSSS entry).
        allowSecretStorageRecreateWithoutRecoveryKey: true,
      });
      await this.enableTrustedRoomKeyBackupIfPossible(crypto);

      const backup = await this.getRoomKeyBackupStatus();
      const createdVersion = backup.serverVersion;
      if (!createdVersion) {
        return await fail("Matrix room key backup is still missing after reset.");
      }
      if (backup.activeVersion !== createdVersion) {
        return await fail(
          "Matrix room key backup was recreated on the server but is not active on this device.",
        );
      }
      if (backup.decryptionKeyCached === false) {
        return await fail(
          "Matrix room key backup was recreated but its decryption key is not cached on this device.",
        );
      }
      if (backup.matchesDecryptionKey === false) {
        return await fail(
          "Matrix room key backup was recreated but this device does not have the matching backup decryption key.",
        );
      }
      if (backup.trusted === false) {
        return await fail(
          "Matrix room key backup was recreated but is not trusted on this device.",
        );
      }

      return {
        success: true,
        previousVersion,
        deletedVersion,
        createdVersion,
        resetAt: new Date().toISOString(),
        backup,
      };
    } catch (err) {
      return await fail(formatErrorMessage(err));
    }
  }

  async getOwnCrossSigningPublicationStatus(): Promise<MatrixOwnCrossSigningPublicationStatus> {
    const userId = this.client.getUserId() ?? this.selfUserId ?? null;
    return await resolveMatrixCrossSigningPublicationStatus({
      userId,
      query: async () =>
        (await this.doRequest("POST", "/_matrix/client/v3/keys/query", undefined, {
          device_keys: userId ? { [userId]: [] as string[] } : {},
        })) as {
          master_keys?: Record<string, unknown>;
          self_signing_keys?: Record<string, unknown>;
          user_signing_keys?: Record<string, unknown>;
        },
    });
  }

  async bootstrapOwnDeviceVerification(params?: {
    allowAutomaticCrossSigningReset?: boolean;
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
    strict?: boolean;
  }): Promise<MatrixVerificationBootstrapResult> {
    const pendingVerifications = async (): Promise<number> =>
      this.crypto ? (await this.crypto.listVerifications()).length : 0;
    if (!this.encryptionEnabled) {
      return {
        success: false,
        error: "Matrix encryption is disabled for this client",
        verification: await this.getOwnDeviceVerificationStatus(),
        crossSigning: await this.getOwnCrossSigningPublicationStatus(),
        pendingVerifications: await pendingVerifications(),
        cryptoBootstrap: null,
      };
    }

    let bootstrapError: string | undefined;
    let bootstrapSummary: MatrixCryptoBootstrapResult | null = null;
    let rawRecoveryKey: string | undefined;
    try {
      await this.ensureStartedForCryptoControlPlane();
      await this.ensureCryptoSupportInitialized();
      const crypto = this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined;
      if (!crypto) {
        throw new Error("Matrix crypto is not available (start client with encryption enabled)");
      }

      rawRecoveryKey = params?.recoveryKey?.trim();
      if (rawRecoveryKey) {
        this.recoveryKeyStore.stageEncodedRecoveryKey({
          encodedPrivateKey: rawRecoveryKey,
          keyId: await this.resolveDefaultSecretStorageKeyId(crypto),
        });
      }

      const cryptoBootstrapper = this.cryptoBootstrapper;
      if (!cryptoBootstrapper) {
        throw new Error("Matrix crypto bootstrapper is not available");
      }
      bootstrapSummary = await cryptoBootstrapper.bootstrap(
        crypto,
        createMatrixExplicitBootstrapOptions({
          ...params,
          allowAutomaticCrossSigningReset: rawRecoveryKey
            ? false
            : params?.allowAutomaticCrossSigningReset,
        }),
      );
      await this.ensureRoomKeyBackupEnabled(crypto);
    } catch (err) {
      this.recoveryKeyStore.discardStagedRecoveryKey();
      bootstrapError = formatErrorMessage(err);
    }

    const verification = await this.getOwnDeviceVerificationStatus();
    const crossSigning = await this.getOwnCrossSigningPublicationStatus();
    const verificationError =
      verification.verified && crossSigning.published
        ? null
        : (bootstrapError ??
          "Matrix verification bootstrap did not produce a device verified by its owner with published cross-signing keys");
    const backupError =
      verificationError === null
        ? resolveMatrixRoomKeyBackupReadinessError(verification.backup, {
            allowUntrustedMatchingKey: Boolean(rawRecoveryKey),
            requireServerBackup: true,
          })
        : null;
    const success = verificationError === null && backupError === null;
    if (success) {
      this.recoveryKeyStore.commitStagedRecoveryKey({
        keyId: await this.resolveDefaultSecretStorageKeyId(
          this.client.getCrypto() as MatrixCryptoBootstrapApi | undefined,
        ),
      });
    } else {
      this.recoveryKeyStore.discardStagedRecoveryKey();
    }
    const error = success ? undefined : (backupError ?? verificationError ?? undefined);
    return {
      success,
      error,
      verification: success ? await this.getOwnDeviceVerificationStatus() : verification,
      crossSigning,
      pendingVerifications: await pendingVerifications(),
      cryptoBootstrap: bootstrapSummary,
    };
  }

  async listOwnDevices(): Promise<MatrixOwnDeviceInfo[]> {
    return await listMatrixOwnDevices(this.client);
  }

  async deleteOwnDevices(deviceIds: string[]): Promise<MatrixOwnDeviceDeleteResult> {
    const uniqueDeviceIds = uniqueStrings(normalizeStringEntries(deviceIds));
    const currentDeviceId = this.client.getDeviceId()?.trim() || null;
    const protectedDeviceIds = uniqueDeviceIds.filter((deviceId) => deviceId === currentDeviceId);
    if (protectedDeviceIds.length > 0) {
      throw new Error(`Refusing to delete the current Matrix device: ${protectedDeviceIds[0]}`);
    }

    const deleteWithAuth = async (authData?: Record<string, unknown>): Promise<void> => {
      await this.client.deleteMultipleDevices(uniqueDeviceIds, authData as never);
    };

    if (uniqueDeviceIds.length > 0) {
      try {
        await deleteWithAuth();
      } catch (err) {
        const session =
          err &&
          typeof err === "object" &&
          "data" in err &&
          err.data &&
          typeof err.data === "object" &&
          "session" in err.data &&
          typeof err.data.session === "string"
            ? err.data.session
            : null;
        const userId = await this.getUserId().catch(() => this.selfUserId);
        if (!session || !userId || !this.password?.trim()) {
          throw err;
        }
        await deleteWithAuth({
          type: "m.login.password",
          session,
          identifier: { type: "m.id.user", user: userId },
          password: this.password,
        });
      }
    }

    return {
      currentDeviceId,
      deletedDeviceIds: uniqueDeviceIds,
      remainingDevices: await this.listOwnDevices(),
    };
  }

  protected registerBridge(): void {
    const decryptBridge = this.decryptBridge;
    if (this.bridgeRegistered || !decryptBridge) {
      return;
    }
    this.bridgeRegistered = true;
    registerMatrixClientBridge({
      client: this.client,
      decryptBridge,
      emitter: this.emitter,
      emitMembershipForRoom: (room) => this.emitMembershipForRoom(room),
      getSelfUserId: () => this.client.getUserId() ?? this.selfUserId ?? "",
      setCurrentSyncState: (state, error) => {
        this.currentSyncState = state;
        this.currentSyncError = error;
      },
    });
  }

  private emitMembershipForRoom(room: Room): void {
    emitMatrixMembershipForRoom({
      client: this.client,
      emitter: this.emitter,
      room,
      selfUserId: this.client.getUserId() ?? this.selfUserId ?? "",
    });
  }

  protected emitOutstandingInviteEvents(): void {
    for (const room of this.client.getRooms()) {
      this.emitMembershipForRoom(room);
    }
  }

  protected async refreshDmCache(): Promise<boolean> {
    return refreshMatrixDmRoomIds(await this.getAccountData("m.direct"), this.dmRoomIds);
  }
}
