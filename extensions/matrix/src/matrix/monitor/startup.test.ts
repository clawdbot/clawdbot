import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import type { MatrixAccountPatch } from "../config-update.js";
import type { MatrixManagedDeviceInfo } from "../device-health.js";
import type { MatrixProfileSyncResult } from "../profile.js";
import type { MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import type { MatrixLegacyCryptoRestoreResult } from "./legacy-crypto-restore.js";
import type { MatrixStartupVerificationOutcome } from "./startup-verification.js";
import type { MatrixStartupMaintenanceDeps } from "./startup.js";
import { runMatrixStartupMaintenance } from "./startup.js";

function createVerificationStatus(
  overrides: Partial<MatrixOwnDeviceVerificationStatus> = {},
): MatrixOwnDeviceVerificationStatus {
  return {
    encryptionEnabled: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE",
    verified: false,
    localVerified: false,
    crossSigningVerified: false,
    signedByOwner: false,
    recoveryKeyStored: false,
    recoveryKeyCreatedAt: null,
    recoveryKeyId: null,
    backupVersion: null,
    backup: {
      serverVersion: null,
      activeVersion: null,
      trusted: null,
      matchesDecryptionKey: null,
      decryptionKeyCached: null,
      keyLoadAttempted: false,
      keyLoadError: null,
    },
    ...overrides,
  };
}

function createProfileSyncResult(
  overrides: Partial<MatrixProfileSyncResult> = {},
): MatrixProfileSyncResult {
  return {
    skipped: false,
    displayNameUpdated: false,
    avatarUpdated: false,
    resolvedAvatarUrl: null,
    uploadedAvatarSource: null,
    convertedAvatarFromHttp: false,
    ...overrides,
  };
}

function createStartupVerificationOutcome(
  kind: Exclude<MatrixStartupVerificationOutcome["kind"], "unsupported">,
  overrides: Partial<Extract<MatrixStartupVerificationOutcome, { kind: typeof kind }>> = {},
): MatrixStartupVerificationOutcome {
  return {
    kind,
    verification: createVerificationStatus({ verified: kind === "verified" }),
    ...overrides,
  } as MatrixStartupVerificationOutcome;
}

function createLegacyCryptoRestoreResult(
  overrides: Partial<MatrixLegacyCryptoRestoreResult> = {},
): MatrixLegacyCryptoRestoreResult {
  return {
    kind: "skipped",
    ...overrides,
  } as MatrixLegacyCryptoRestoreResult;
}

function createDeps(
  overrides: Partial<MatrixStartupMaintenanceDeps> = {},
): MatrixStartupMaintenanceDeps {
  return {
    maybeRestoreLegacyMatrixBackup: vi.fn(async () => createLegacyCryptoRestoreResult()),
    summarizeMatrixDeviceHealth: vi.fn(() => ({
      currentDeviceId: null,
      staleOpenClawDevices: [] as MatrixManagedDeviceInfo[],
      currentOpenClawDevices: [] as MatrixManagedDeviceInfo[],
    })),
    syncMatrixOwnProfile: vi.fn(async () => createProfileSyncResult()),
    ensureMatrixStartupVerification: vi.fn(async () =>
      createStartupVerificationOutcome("verified"),
    ),
    updateMatrixAccountConfig: vi.fn(
      (cfg: CoreConfig, _accountId: string, _patch: MatrixAccountPatch) => cfg,
    ),
    ...overrides,
  };
}

describe("runMatrixStartupMaintenance", () => {
  let deps: MatrixStartupMaintenanceDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  function createParams(): Parameters<typeof runMatrixStartupMaintenance>[0] {
    return {
      client: {
        crypto: {},
        listOwnDevices: vi.fn(async () => []),
        getOwnDeviceVerificationStatus: vi.fn(async () => createVerificationStatus()),
      } as never,
      auth: {
        accountId: "ops",
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
        encryption: false,
      },
      accountId: "ops",
      effectiveAccountId: "ops",
      accountConfig: {
        name: "Ops Bot",
        avatarUrl: "https://example.org/avatar.png",
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      logVerboseMessage: vi.fn(),
      loadConfig: vi.fn(() => ({ channels: { matrix: {} } })),
      writeConfigFile: vi.fn(async () => {}),
      loadWebMedia: vi.fn(async () => ({
        buffer: Buffer.from("avatar"),
        contentType: "image/png",
        fileName: "avatar.png",
      })),
      abortSignal: undefined,
      env: {},
    };
  }

  it("persists converted avatar URLs after profile sync", async () => {
    const params = createParams();
    const updatedCfg = { channels: { matrix: { avatarUrl: "mxc://avatar" } } };
    vi.mocked(deps.syncMatrixOwnProfile).mockResolvedValue(
      createProfileSyncResult({
        avatarUpdated: true,
        resolvedAvatarUrl: "mxc://avatar",
        uploadedAvatarSource: "http",
        convertedAvatarFromHttp: true,
      }),
    );
    vi.mocked(deps.updateMatrixAccountConfig).mockReturnValue(updatedCfg);

    await runMatrixStartupMaintenance(params, deps);

    expect(deps.syncMatrixOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "@bot:example.org",
        displayName: "Ops Bot",
        avatarUrl: "https://example.org/avatar.png",
      }),
    );
    expect(deps.updateMatrixAccountConfig).toHaveBeenCalledWith(
      { channels: { matrix: {} } },
      "ops",
      { avatarUrl: "mxc://avatar" },
    );
    expect(params.writeConfigFile).toHaveBeenCalledWith(updatedCfg as never);
    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: persisted converted avatar URL for account ops (mxc://avatar)",
    );
  });

  it("reports stale devices, pending verification, and restored legacy backups", async () => {
    const params = createParams();
    params.auth.encryption = true;
    vi.mocked(deps.summarizeMatrixDeviceHealth).mockReturnValue({
      currentDeviceId: null,
      staleOpenClawDevices: [
        { deviceId: "DEV123", displayName: "OpenClaw Device", current: false },
      ],
      currentOpenClawDevices: [],
    });
    vi.mocked(deps.ensureMatrixStartupVerification).mockResolvedValue(
      createStartupVerificationOutcome("pending"),
    );
    vi.mocked(deps.maybeRestoreLegacyMatrixBackup).mockResolvedValue(
      createLegacyCryptoRestoreResult({
        kind: "restored",
        imported: 2,
        total: 3,
        localOnlyKeys: 1,
      }),
    );

    await runMatrixStartupMaintenance(params, deps);

    expect(params.logger.warn).toHaveBeenCalledWith(
      "matrix: stale OpenClaw devices detected for @bot:example.org: DEV123. Run 'openclaw matrix devices prune-stale --account ops' to keep encrypted-room trust healthy.",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: device not verified — run 'openclaw matrix verify device <key>' to enable E2EE",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: startup verification request is already pending; finish it in another Matrix client",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      "matrix: restored 2/3 room key(s) from legacy encrypted-state backup",
    );
    expect(params.logger.warn).toHaveBeenCalledWith(
      "matrix: 1 legacy local-only room key(s) were never backed up and could not be restored automatically",
    );
  });

  it("logs cooldown and request-failure verification outcomes without throwing", async () => {
    const params = createParams();
    params.auth.encryption = true;
    vi.mocked(deps.ensureMatrixStartupVerification).mockResolvedValueOnce(
      createStartupVerificationOutcome("cooldown", { retryAfterMs: 321 }),
    );

    await runMatrixStartupMaintenance(params, deps);

    expect(params.logVerboseMessage).toHaveBeenCalledWith(
      "matrix: skipped startup verification request due to cooldown (retryAfterMs=321)",
    );

    vi.mocked(deps.ensureMatrixStartupVerification).mockResolvedValueOnce(
      createStartupVerificationOutcome("request-failed", { error: "boom" }),
    );

    await runMatrixStartupMaintenance(params, deps);

    expect(params.logger.debug).toHaveBeenCalledWith(
      "Matrix startup verification request failed (non-fatal)",
      { error: "boom" },
    );
  });

  it("aborts maintenance before later startup steps continue", async () => {
    const params = createParams();
    params.auth.encryption = true;
    const abortController = new AbortController();
    params.abortSignal = abortController.signal;
    vi.mocked(deps.syncMatrixOwnProfile).mockImplementation(async () => {
      abortController.abort();
      return createProfileSyncResult();
    });

    await expect(runMatrixStartupMaintenance(params, deps)).rejects.toMatchObject({
      message: "Matrix startup aborted",
      name: "AbortError",
    });
    expect(deps.ensureMatrixStartupVerification).not.toHaveBeenCalled();
    expect(deps.maybeRestoreLegacyMatrixBackup).not.toHaveBeenCalled();
  });
});
