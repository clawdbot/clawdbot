import type { RuntimeLogger } from "../../runtime-api.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixStartupAbortError, throwIfMatrixStartupAborted } from "../startup-abort.js";

type MatrixStartupClient = Pick<
  MatrixClient,
  | "crypto"
  | "getOwnDeviceVerificationStatus"
  | "getUserProfile"
  | "listOwnDevices"
  | "restoreRoomKeyBackup"
  | "setAvatarUrl"
  | "setDisplayName"
  | "uploadContent"
>;

export type MatrixStartupMaintenanceDeps = {
  updateMatrixAccountConfig: typeof import("../config-update.js").updateMatrixAccountConfig;
  summarizeMatrixDeviceHealth: typeof import("../device-health.js").summarizeMatrixDeviceHealth;
  syncMatrixOwnProfile: typeof import("../profile.js").syncMatrixOwnProfile;
  maybeRestoreLegacyMatrixBackup: typeof import("./legacy-crypto-restore.js").maybeRestoreLegacyMatrixBackup;
  ensureMatrixStartupVerification: typeof import("./startup-verification.js").ensureMatrixStartupVerification;
};

let matrixStartupMaintenanceDepsPromise: Promise<MatrixStartupMaintenanceDeps> | undefined;

async function loadMatrixStartupMaintenanceDeps(): Promise<MatrixStartupMaintenanceDeps> {
  matrixStartupMaintenanceDepsPromise ??= Promise.all([
    import("../config-update.js"),
    import("../device-health.js"),
    import("../profile.js"),
    import("./legacy-crypto-restore.js"),
    import("./startup-verification.js"),
  ]).then(
    ([
      configUpdateModule,
      deviceHealthModule,
      profileModule,
      legacyCryptoRestoreModule,
      startupVerificationModule,
    ]) => ({
      updateMatrixAccountConfig: configUpdateModule.updateMatrixAccountConfig,
      summarizeMatrixDeviceHealth: deviceHealthModule.summarizeMatrixDeviceHealth,
      syncMatrixOwnProfile: profileModule.syncMatrixOwnProfile,
      maybeRestoreLegacyMatrixBackup: legacyCryptoRestoreModule.maybeRestoreLegacyMatrixBackup,
      ensureMatrixStartupVerification: startupVerificationModule.ensureMatrixStartupVerification,
    }),
  );
  return await matrixStartupMaintenanceDepsPromise;
}

export async function runMatrixStartupMaintenance(
  params: {
    client: MatrixStartupClient;
    auth: MatrixAuth;
    accountId: string;
    effectiveAccountId: string;
    accountConfig: MatrixConfig;
    logger: RuntimeLogger;
    logVerboseMessage: (message: string) => void;
    getRuntimeConfig: () => CoreConfig;
    replaceConfigFile: (cfg: never) => Promise<void>;
    loadWebMedia: (
      url: string,
      maxBytes: number,
    ) => Promise<{ buffer: Buffer; contentType?: string; fileName?: string }>;
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
  },
  deps?: MatrixStartupMaintenanceDeps,
): Promise<void> {
  const runtimeDeps = deps ?? (await loadMatrixStartupMaintenanceDeps());
  throwIfMatrixStartupAborted(params.abortSignal);
  try {
    const profileSync = await runtimeDeps.syncMatrixOwnProfile({
      client: params.client,
      userId: params.auth.userId,
      displayName: params.accountConfig.name,
      avatarUrl: params.accountConfig.avatarUrl,
      loadAvatarFromUrl: async (url, maxBytes) => await params.loadWebMedia(url, maxBytes),
    });
    throwIfMatrixStartupAborted(params.abortSignal);
    if (profileSync.displayNameUpdated) {
      params.logger.info(`matrix: profile display name updated for ${params.auth.userId}`);
    }
    if (profileSync.avatarUpdated) {
      params.logger.info(`matrix: profile avatar updated for ${params.auth.userId}`);
    }
    if (
      profileSync.convertedAvatarFromHttp &&
      profileSync.resolvedAvatarUrl &&
      params.accountConfig.avatarUrl !== profileSync.resolvedAvatarUrl
    ) {
      const latestCfg = params.getRuntimeConfig();
      const updatedCfg = runtimeDeps.updateMatrixAccountConfig(latestCfg, params.accountId, {
        avatarUrl: profileSync.resolvedAvatarUrl,
      });
      await params.replaceConfigFile(updatedCfg as never);
      throwIfMatrixStartupAborted(params.abortSignal);
      params.logVerboseMessage(
        `matrix: persisted converted avatar URL for account ${params.accountId} (${profileSync.resolvedAvatarUrl})`,
      );
    }
  } catch (err) {
    if (isMatrixStartupAbortError(err)) {
      throw err;
    }
    params.logger.warn("matrix: failed to sync profile from config", { error: String(err) });
  }

  if (!(params.auth.encryption && params.client.crypto)) {
    return;
  }

  try {
    throwIfMatrixStartupAborted(params.abortSignal);
    const deviceHealth = runtimeDeps.summarizeMatrixDeviceHealth(
      await params.client.listOwnDevices(),
    );
    if (deviceHealth.staleOpenClawDevices.length > 0) {
      params.logger.warn(
        `matrix: stale OpenClaw devices detected for ${params.auth.userId}: ${deviceHealth.staleOpenClawDevices.map((device) => device.deviceId).join(", ")}. Run 'openclaw matrix devices prune-stale --account ${params.effectiveAccountId}' to keep encrypted-room trust healthy.`,
      );
    }
  } catch (err) {
    if (isMatrixStartupAbortError(err)) {
      throw err;
    }
    params.logger.debug?.("Failed to inspect matrix device hygiene (non-fatal)", {
      error: String(err),
    });
  }

  try {
    throwIfMatrixStartupAborted(params.abortSignal);
    const startupVerification = await runtimeDeps.ensureMatrixStartupVerification({
      client: params.client,
      auth: params.auth,
      accountConfig: params.accountConfig,
      env: params.env,
    });
    throwIfMatrixStartupAborted(params.abortSignal);
    if (startupVerification.kind === "verified") {
      params.logger.info("matrix: device is verified by its owner and ready for encrypted rooms");
    } else if (
      startupVerification.kind === "disabled" ||
      startupVerification.kind === "cooldown" ||
      startupVerification.kind === "pending" ||
      startupVerification.kind === "request-failed"
    ) {
      params.logger.info(
        "matrix: device not verified — run 'openclaw matrix verify device <key>' to enable E2EE",
      );
      if (startupVerification.kind === "pending") {
        params.logger.info(
          "matrix: startup verification request is already pending; finish it in another Matrix client",
        );
      } else if (startupVerification.kind === "cooldown") {
        params.logVerboseMessage(
          `matrix: skipped startup verification request due to cooldown (retryAfterMs=${startupVerification.retryAfterMs ?? 0})`,
        );
      } else if (startupVerification.kind === "request-failed") {
        params.logger.debug?.("Matrix startup verification request failed (non-fatal)", {
          error: startupVerification.error ?? "unknown",
        });
      }
    } else if (startupVerification.kind === "requested") {
      params.logger.info(
        "matrix: device not verified — requested verification in another Matrix client",
      );
    }
  } catch (err) {
    if (isMatrixStartupAbortError(err)) {
      throw err;
    }
    params.logger.debug?.("Failed to resolve matrix verification status (non-fatal)", {
      error: String(err),
    });
  }

  try {
    throwIfMatrixStartupAborted(params.abortSignal);
    const legacyCryptoRestore = await runtimeDeps.maybeRestoreLegacyMatrixBackup({
      client: params.client,
      auth: params.auth,
      env: params.env,
    });
    throwIfMatrixStartupAborted(params.abortSignal);
    if (legacyCryptoRestore.kind === "restored") {
      params.logger.info(
        `matrix: restored ${legacyCryptoRestore.imported}/${legacyCryptoRestore.total} room key(s) from legacy encrypted-state backup`,
      );
      if (legacyCryptoRestore.localOnlyKeys > 0) {
        params.logger.warn(
          `matrix: ${legacyCryptoRestore.localOnlyKeys} legacy local-only room key(s) were never backed up and could not be restored automatically`,
        );
      }
    } else if (legacyCryptoRestore.kind === "failed") {
      params.logger.warn(
        `matrix: failed restoring room keys from legacy encrypted-state backup: ${legacyCryptoRestore.error}`,
      );
      if (legacyCryptoRestore.localOnlyKeys > 0) {
        params.logger.warn(
          `matrix: ${legacyCryptoRestore.localOnlyKeys} legacy local-only room key(s) were never backed up and may remain unavailable until manually recovered`,
        );
      }
    }
  } catch (err) {
    if (isMatrixStartupAbortError(err)) {
      throw err;
    }
    params.logger.warn("matrix: failed restoring legacy encrypted-state backup", {
      error: String(err),
    });
  }
}
