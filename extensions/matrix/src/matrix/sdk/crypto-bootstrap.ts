// Matrix plugin module implements crypto bootstrap behavior.
import { setTimeout as sleep } from "node:timers/promises";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import type { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { LogService } from "./logger.js";
import type { MatrixRecoveryKeyStore } from "./recovery-key-store.js";
import { isRepairableSecretStorageAccessError } from "./recovery-key-store.js";
import type {
  MatrixAuthDict,
  MatrixCryptoBootstrapApi,
  MatrixRawEvent,
  MatrixUiAuthCallback,
  MatrixUiaResponseBody,
} from "./types.js";
import type {
  MatrixVerificationManager,
  MatrixVerificationRequestLike,
} from "./verification-manager.js";
import { isMatrixDeviceOwnerVerified } from "./verification-status.js";

type MatrixCryptoBootstrapperDeps<TRawEvent extends MatrixRawEvent> = {
  getUserId: () => Promise<string>;
  getPassword?: () => string | undefined;
  canUnlockSecretStorage: () => Promise<boolean>;
  getDeviceId: () => string | null | undefined;
  verificationManager: MatrixVerificationManager;
  recoveryKeyStore: MatrixRecoveryKeyStore;
  decryptBridge: Pick<MatrixDecryptBridge<TRawEvent>, "bindCryptoRetrySignals">;
};

export type MatrixCryptoBootstrapOptions = {
  forceResetCrossSigning?: boolean;
  allowAutomaticCrossSigningReset?: boolean;
  allowSecretStorageRecreateWithoutRecoveryKey?: boolean;
  strict?: boolean;
};

export type MatrixCryptoBootstrapResult = {
  crossSigningReady: boolean;
  crossSigningPublished: boolean;
  ownDeviceVerified: boolean | null;
};

const CROSS_SIGNING_PUBLICATION_WAIT_MS = 5_000;

const INTERACTIVE_RESET_UIA_STAGES = new Set(["org.matrix.cross_signing_reset", "m.oauth"]);

type CrossSigningBootstrapOptions = {
  forceResetCrossSigning: boolean;
  allowAutomaticCrossSigningReset: boolean;
  allowSecretStorageRecreateWithoutRecoveryKey: boolean;
  strict: boolean;
};

type MatrixUiaChallenge = { httpStatus: number; data: MatrixUiaResponseBody };

function asUiaChallenge(err: unknown): MatrixUiaChallenge | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = err as { httpStatus?: unknown; data?: { flows?: unknown } };
  if (candidate.httpStatus !== 401 || !Array.isArray(candidate.data?.flows)) {
    return null;
  }
  return candidate as MatrixUiaChallenge;
}

function collectUiaStages(body: MatrixUiaResponseBody): string[] {
  const stages: string[] = [];
  for (const flow of body.flows ?? []) {
    for (const stage of flow?.stages ?? []) {
      if (typeof stage === "string" && !stages.includes(stage)) {
        stages.push(stage);
      }
    }
  }
  return stages;
}

function completedUiaStages(body: MatrixUiaResponseBody): Set<string> {
  const completed = new Set<string>();
  for (const stage of body.completed ?? []) {
    if (typeof stage === "string") {
      completed.add(stage);
    }
  }
  return completed;
}

function uiaSession(body: MatrixUiaResponseBody): string | undefined {
  return typeof body.session === "string" && body.session ? body.session : undefined;
}

function selectNextSupportedUiaStage(
  body: MatrixUiaResponseBody,
  opts: { hasPassword: boolean },
): string | undefined {
  const completed = completedUiaStages(body);
  const supported = (stage: string): boolean =>
    stage === "m.login.dummy" || (stage === "m.login.password" && opts.hasPassword);
  let fallback: string | undefined;
  for (const flow of body.flows ?? []) {
    const stages = (flow?.stages ?? []).filter((stage): stage is string => {
      return typeof stage === "string";
    });
    const remaining = stages.filter((stage) => !completed.has(stage));
    if (remaining.length === 0) {
      continue;
    }
    if (remaining.every((stage) => stage === "m.login.dummy")) {
      return remaining[0];
    }
    if (fallback === undefined && remaining.every(supported)) {
      fallback = remaining[0];
    }
  }
  return fallback;
}

function extractUiaStageUrl(body: MatrixUiaResponseBody, stage: string): string | undefined {
  const params = body.params?.[stage];
  const url = params && typeof params.url === "string" ? params.url.trim() : "";
  return url || undefined;
}

class MatrixCrossSigningResetRequiredError extends Error {
  readonly stages: string[];
  readonly resetUrl?: string;
  readonly session?: string;

  constructor(opts: { stages: string[]; resetUrl?: string; session?: string }) {
    const resetUrl = opts.resetUrl?.trim() || undefined;
    super(
      resetUrl
        ? `Matrix cross-signing key upload requires interactive approval from the homeserver auth service. Open ${resetUrl} in a browser as the bot user, approve the cross-signing reset, then re-run the bootstrap while the approval is fresh.`
        : "Matrix cross-signing key upload requires interactive approval from the homeserver auth service, but no approval URL was advertised. Reset the user's server-side cross-signing keys with homeserver admin tooling, then re-run the bootstrap.",
    );
    this.name = "MatrixCrossSigningResetRequiredError";
    this.stages = opts.stages;
    this.resetUrl = resetUrl;
    this.session = opts.session;
  }
}

class MatrixUiaUnsupportedStagesError extends Error {
  readonly stages: string[];

  constructor(opts: { stages: string[]; hasPassword: boolean }) {
    const stageList = opts.stages.length > 0 ? opts.stages.join(", ") : "none advertised";
    super(
      `Matrix cross-signing key upload requires UIA stages this client cannot satisfy non-interactively: ${stageList}.${
        opts.hasPassword ? "" : " Set matrix.password to enable the m.login.password fallback."
      }`,
    );
    this.name = "MatrixUiaUnsupportedStagesError";
    this.stages = opts.stages;
  }
}

export class MatrixCryptoBootstrapper<TRawEvent extends MatrixRawEvent> {
  private verificationHandlerRegistered = false;

  constructor(private readonly deps: MatrixCryptoBootstrapperDeps<TRawEvent>) {}

  async bootstrap(
    crypto: MatrixCryptoBootstrapApi,
    options: MatrixCryptoBootstrapOptions = {},
  ): Promise<MatrixCryptoBootstrapResult> {
    const strict = options.strict === true;
    const forceReset = options.forceResetCrossSigning === true;
    const deferSecretStorageBootstrapUntilAfterCrossSigning = forceReset;
    if (forceReset && !(await this.deps.canUnlockSecretStorage())) {
      throw new Error(
        "Forced cross-signing reset requires the active Matrix recovery key; supply it before retrying",
      );
    }
    // Register verification listeners before expensive bootstrap work so incoming requests
    // are not missed during startup.
    this.registerVerificationRequestHandler(crypto);

    if (!deferSecretStorageBootstrapUntilAfterCrossSigning) {
      await this.bootstrapSecretStorage(crypto, {
        strict,
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      });
    }

    const crossSigning = await this.bootstrapCrossSigning(crypto, {
      forceResetCrossSigning: forceReset,
      allowAutomaticCrossSigningReset: options.allowAutomaticCrossSigningReset !== false,
      // A repair retry would generate another identity after the SDK already rotated local keys.
      // Fail closed instead; the server identity and existing recovery material remain authoritative.
      allowSecretStorageRecreateWithoutRecoveryKey: forceReset
        ? false
        : options.allowSecretStorageRecreateWithoutRecoveryKey === true,
      strict,
    });

    if (forceReset && (!crossSigning.ready || !crossSigning.published)) {
      return {
        crossSigningReady: crossSigning.ready,
        crossSigningPublished: crossSigning.published,
        ownDeviceVerified: null,
      };
    }

    // Second SSSS pass to pick up cross-signing keys published during bootstrap.
    await this.bootstrapSecretStorage(crypto, {
      strict,
      allowSecretStorageRecreateWithoutRecoveryKey:
        options.allowSecretStorageRecreateWithoutRecoveryKey === true,
    });

    const ownDeviceVerified = await this.ensureOwnDeviceTrust(crypto, {
      strict,
    });
    return {
      crossSigningReady: crossSigning.ready,
      crossSigningPublished: crossSigning.published,
      ownDeviceVerified,
    };
  }

  private createSigningKeysUiAuthCallback(params: {
    userId: string;
    password?: string;
  }): MatrixUiAuthCallback {
    return async <T>(makeRequest: (authData: MatrixAuthDict | null) => Promise<T>): Promise<T> => {
      let challenge: MatrixUiaChallenge;
      try {
        return await makeRequest(null);
      } catch (err) {
        const parsed = asUiaChallenge(err);
        if (!parsed) {
          throw err;
        }
        challenge = parsed;
      }
      const password = params.password?.trim();
      for (;;) {
        const nextStage = selectNextSupportedUiaStage(challenge.data, {
          hasPassword: Boolean(password),
        });
        if (!nextStage) {
          const stages = collectUiaStages(challenge.data);
          const session = uiaSession(challenge.data);
          const resetStage = stages.find((stage) => INTERACTIVE_RESET_UIA_STAGES.has(stage));
          if (resetStage) {
            throw new MatrixCrossSigningResetRequiredError({
              stages,
              resetUrl: extractUiaStageUrl(challenge.data, resetStage),
              session,
            });
          }
          throw new MatrixUiaUnsupportedStagesError({ stages, hasPassword: Boolean(password) });
        }
        const session = uiaSession(challenge.data);
        const authData: MatrixAuthDict =
          nextStage === "m.login.password" && password
            ? {
                type: "m.login.password",
                identifier: { type: "m.id.user", user: params.userId },
                password,
              }
            : { type: "m.login.dummy" };
        try {
          return await makeRequest(session ? { ...authData, session } : authData);
        } catch (err) {
          const parsed = asUiaChallenge(err);
          if (!parsed) {
            throw err;
          }
          if (completedUiaStages(parsed.data).size <= completedUiaStages(challenge.data).size) {
            throw err;
          }
          challenge = parsed;
        }
      }
    };
  }

  private async bootstrapCrossSigning(
    crypto: MatrixCryptoBootstrapApi,
    options: CrossSigningBootstrapOptions,
  ): Promise<{ ready: boolean; published: boolean }> {
    try {
      return await this.runCrossSigningBootstrap(crypto, options);
    } catch (err) {
      if (err instanceof MatrixCrossSigningResetRequiredError) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing bootstrap needs interactive approval:",
          err.message,
        );
        if (options.strict) {
          throw err;
        }
        return { ready: false, published: false };
      }
      throw err;
    }
  }

  private async runCrossSigningBootstrap(
    crypto: MatrixCryptoBootstrapApi,
    options: CrossSigningBootstrapOptions,
  ): Promise<{ ready: boolean; published: boolean }> {
    const userId = await this.deps.getUserId();
    const authUploadDeviceSigningKeys = this.createSigningKeysUiAuthCallback({
      userId,
      password: this.deps.getPassword?.(),
    });
    const hasPublishedCrossSigningKeys = async (): Promise<boolean> => {
      if (typeof crypto.userHasCrossSigningKeys !== "function") {
        return true;
      }
      try {
        return await crypto.userHasCrossSigningKeys(userId, true);
      } catch {
        return false;
      }
    };
    const refreshPublishedCrossSigningKeys = async (): Promise<void> => {
      if (typeof crypto.userHasCrossSigningKeys !== "function") {
        return;
      }
      try {
        await crypto.userHasCrossSigningKeys(userId, true);
      } catch {
        // The normal bootstrap flow below handles missing or unavailable keys.
      }
    };
    const isCrossSigningReady = async (): Promise<boolean> => {
      if (typeof crypto.isCrossSigningReady !== "function") {
        return true;
      }
      try {
        return await crypto.isCrossSigningReady();
      } catch {
        return false;
      }
    };

    const finalize = async (): Promise<{ ready: boolean; published: boolean }> => {
      const ready = await isCrossSigningReady();
      const published = ready
        ? await waitForPublishedCrossSigningKeys()
        : await hasPublishedCrossSigningKeys();
      if (ready && published) {
        LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
        return { ready, published };
      }
      const message = "Cross-signing bootstrap finished but server keys are still not published";
      LogService.warn("MatrixClientLite", message);
      if (options.strict) {
        throw new Error(message);
      }
      return { ready, published };
    };

    const waitForPublishedCrossSigningKeys = async (): Promise<boolean> => {
      const startedAt = Date.now();
      do {
        if (await hasPublishedCrossSigningKeys()) {
          return true;
        }
        await sleep(250);
      } while (Date.now() - startedAt < CROSS_SIGNING_PUBLICATION_WAIT_MS);
      return false;
    };

    if (options.forceResetCrossSigning) {
      const resetCrossSigning = async (): Promise<void> => {
        await crypto.bootstrapCrossSigning({
          setupNewCrossSigning: true,
          authUploadDeviceSigningKeys,
        });
      };
      try {
        await resetCrossSigning();
        await this.trustFreshOwnIdentity(crypto);
      } catch (err) {
        if (err instanceof MatrixCrossSigningResetRequiredError) {
          throw err;
        }
        const shouldRepairSecretStorage =
          options.allowSecretStorageRecreateWithoutRecoveryKey &&
          isRepairableSecretStorageAccessError(err);
        if (shouldRepairSecretStorage) {
          LogService.warn(
            "MatrixClientLite",
            "Forced cross-signing reset could not unlock secret storage; recreating secret storage and retrying.",
          );
          try {
            await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
              allowSecretStorageRecreateWithoutRecoveryKey: true,
              forceNewSecretStorage: true,
            });
            await resetCrossSigning();
            await this.trustFreshOwnIdentity(crypto);
          } catch (repairErr) {
            if (repairErr instanceof MatrixCrossSigningResetRequiredError) {
              throw repairErr;
            }
            LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", repairErr);
            if (options.strict) {
              throw repairErr instanceof Error ? repairErr : new Error(String(repairErr));
            }
            return { ready: false, published: false };
          }
          return await finalize();
        }
        LogService.warn("MatrixClientLite", "Forced cross-signing reset failed:", err);
        if (options.strict) {
          if (isRepairableSecretStorageAccessError(err)) {
            throw new Error(
              "Forced cross-signing reset cannot access secret storage; restore the Matrix recovery key before retrying",
              { cause: err },
            );
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
        return { ready: false, published: false };
      }
      return await finalize();
    }

    // First pass: preserve existing cross-signing identity and ensure public keys are uploaded.
    try {
      await refreshPublishedCrossSigningKeys();
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys,
      });
    } catch (err) {
      if (err instanceof MatrixCrossSigningResetRequiredError) {
        throw err;
      }
      const shouldRepairSecretStorage =
        options.allowSecretStorageRecreateWithoutRecoveryKey &&
        isRepairableSecretStorageAccessError(err);
      if (shouldRepairSecretStorage) {
        LogService.warn(
          "MatrixClientLite",
          "Cross-signing bootstrap could not unlock secret storage; recreating secret storage during explicit bootstrap and retrying.",
        );
        await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
          allowSecretStorageRecreateWithoutRecoveryKey: true,
          forceNewSecretStorage: true,
        });
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys,
        });
      } else if (!options.allowAutomaticCrossSigningReset) {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed and automatic reset is disabled:",
          err,
        );
        return { ready: false, published: false };
      } else {
        LogService.warn(
          "MatrixClientLite",
          "Initial cross-signing bootstrap failed, trying reset:",
          err,
        );
        try {
          await crypto.bootstrapCrossSigning({
            setupNewCrossSigning: true,
            authUploadDeviceSigningKeys,
          });
        } catch (resetErr) {
          if (resetErr instanceof MatrixCrossSigningResetRequiredError) {
            throw resetErr;
          }
          LogService.warn("MatrixClientLite", "Failed to bootstrap cross-signing:", resetErr);
          if (options.strict) {
            throw resetErr instanceof Error ? resetErr : new Error(String(resetErr));
          }
          return { ready: false, published: false };
        }
      }
    }

    const firstPassReady = await isCrossSigningReady();
    const firstPassPublished = await hasPublishedCrossSigningKeys();
    if (firstPassReady && firstPassPublished) {
      LogService.info("MatrixClientLite", "Cross-signing bootstrap complete");
      return { ready: true, published: true };
    }

    if (!options.allowAutomaticCrossSigningReset) {
      return { ready: firstPassReady, published: firstPassPublished };
    }

    // Fallback: recover from broken local/server state by creating a fresh identity.
    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys,
      });
      await this.trustFreshOwnIdentity(crypto);
    } catch (err) {
      if (err instanceof MatrixCrossSigningResetRequiredError) {
        throw err;
      }
      LogService.warn("MatrixClientLite", "Fallback cross-signing bootstrap failed:", err);
      if (options.strict) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return { ready: false, published: false };
    }

    return await finalize();
  }

  private async trustFreshOwnIdentity(crypto: MatrixCryptoBootstrapApi): Promise<void> {
    const ownIdentity =
      typeof crypto.getOwnIdentity === "function"
        ? await crypto.getOwnIdentity().catch(() => undefined)
        : undefined;
    if (!ownIdentity) {
      return;
    }

    try {
      if (typeof ownIdentity.isVerified === "function" && ownIdentity.isVerified()) {
        return;
      }
      await ownIdentity.verify?.();
    } finally {
      ownIdentity.free?.();
    }
  }

  private async bootstrapSecretStorage(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      strict: boolean;
      allowSecretStorageRecreateWithoutRecoveryKey: boolean;
    },
  ): Promise<void> {
    try {
      await this.deps.recoveryKeyStore.bootstrapSecretStorageWithRecoveryKey(crypto, {
        allowSecretStorageRecreateWithoutRecoveryKey:
          options.allowSecretStorageRecreateWithoutRecoveryKey,
      });
      LogService.info("MatrixClientLite", "Secret storage bootstrap complete");
    } catch (err) {
      LogService.warn("MatrixClientLite", "Failed to bootstrap secret storage:", err);
      if (options.strict) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  private registerVerificationRequestHandler(crypto: MatrixCryptoBootstrapApi): void {
    if (this.verificationHandlerRegistered) {
      return;
    }
    this.verificationHandlerRegistered = true;

    // Track incoming requests; verification lifecycle decisions live in the
    // verification manager so acceptance/start/dedupe share one code path.
    // Remote-user verifications are only auto-accepted. The human-operated
    // client must explicitly choose "Verify by emoji" so we do not race a
    // second SAS start from the bot side and end up with mismatched keys.
    crypto.on(CryptoEvent.VerificationRequestReceived, (request) => {
      const verificationRequest = request as MatrixVerificationRequestLike;
      try {
        this.deps.verificationManager.trackVerificationRequest(verificationRequest);
      } catch (err) {
        LogService.warn(
          "MatrixClientLite",
          `Failed to track verification request from ${verificationRequest.otherUserId}:`,
          err,
        );
      }
    });

    this.deps.decryptBridge.bindCryptoRetrySignals(crypto);
    LogService.info("MatrixClientLite", "Verification request handler registered");
  }

  private async ensureOwnDeviceTrust(
    crypto: MatrixCryptoBootstrapApi,
    options: {
      strict: boolean;
    },
  ): Promise<boolean | null> {
    const deviceId = this.deps.getDeviceId()?.trim();
    if (!deviceId) {
      return null;
    }
    const userId = await this.deps.getUserId();

    const deviceStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const alreadyVerified = isMatrixDeviceOwnerVerified(deviceStatus);

    if (alreadyVerified) {
      return true;
    }

    if (typeof crypto.setDeviceVerified === "function") {
      await crypto.setDeviceVerified(userId, deviceId, true);
    }

    if (typeof crypto.crossSignDevice === "function") {
      const crossSigningReady =
        typeof crypto.isCrossSigningReady === "function"
          ? await crypto.isCrossSigningReady()
          : true;
      if (crossSigningReady) {
        await crypto.crossSignDevice(deviceId);
      }
    }

    const refreshedStatus =
      typeof crypto.getDeviceVerificationStatus === "function"
        ? await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null)
        : null;
    const verified = isMatrixDeviceOwnerVerified(refreshedStatus);
    if (!verified && options.strict) {
      throw new Error(
        `Matrix own device ${deviceId} does not have full Matrix identity trust after bootstrap`,
      );
    }
    return verified;
  }
}
