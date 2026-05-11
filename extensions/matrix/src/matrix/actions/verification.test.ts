import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const withResolvedActionClientMock = vi.fn();
const withStartedActionClientMock = vi.fn();
const loadConfigMock = vi.fn(() => ({
  channels: {
    matrix: {},
  },
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      current: loadConfigMock,
    },
  }),
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

let listMatrixVerifications: typeof import("./verification.js").listMatrixVerifications;
let getMatrixEncryptionStatus: typeof import("./verification.js").getMatrixEncryptionStatus;
let getMatrixRoomKeyBackupStatus: typeof import("./verification.js").getMatrixRoomKeyBackupStatus;
let getMatrixVerificationStatus: typeof import("./verification.js").getMatrixVerificationStatus;
let restoreMatrixRoomKeyBackup: typeof import("./verification.js").restoreMatrixRoomKeyBackup;
let runMatrixSelfVerification: typeof import("./verification.js").runMatrixSelfVerification;
let startMatrixVerification: typeof import("./verification.js").startMatrixVerification;
let confirmMatrixVerificationSas: typeof import("./verification.js").confirmMatrixVerificationSas;

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCallArg(source: MockCallSource, label: string, callIndex = 0, argIndex = 0): unknown {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex} to exist`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to exist`);
  }
  return call[argIndex];
}

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const value = mockCallArg(source, label, callIndex, argIndex);
  if (!value || typeof value !== "object") {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectResolvedActionClientReadinessNone(): void {
  expect(mockObjectArg(withResolvedActionClientMock, "withResolvedActionClient").readiness).toBe(
    "none",
  );
  expect(mockCallArg(withResolvedActionClientMock, "withResolvedActionClient", 0, 1)).toBeTypeOf(
    "function",
  );
  expect(mockCallArg(withResolvedActionClientMock, "withResolvedActionClient", 0, 2)).toBe(
    "discard",
  );
}

describe("matrix verification actions", () => {
  beforeAll(async () => {
    ({
      confirmMatrixVerificationSas,
      getMatrixEncryptionStatus,
      getMatrixRoomKeyBackupStatus,
      getMatrixVerificationStatus,
      listMatrixVerifications,
      restoreMatrixRoomKeyBackup,
      runMatrixSelfVerification,
      startMatrixVerification,
    } = await import("./verification.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {},
      },
    });
  });

  function mockVerifiedOwnerStatus() {
    return {
      backup: {
        activeVersion: "1",
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
        matchesDecryptionKey: true,
        serverVersion: "1",
        trusted: true,
      },
      backupVersion: "1",
      crossSigningVerified: true,
      deviceId: "DEVICE123",
      localVerified: true,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: null,
      recoveryKeyStored: false,
      signedByOwner: true,
      userId: "@bot:example.org",
      verified: true,
    };
  }

  function mockUnverifiedOwnerStatus() {
    return {
      ...mockVerifiedOwnerStatus(),
      crossSigningVerified: false,
      localVerified: false,
      signedByOwner: false,
      verified: false,
    };
  }

  function mockCrossSigningPublicationStatus(published = true) {
    return {
      masterKeyPublished: published,
      published,
      selfSigningKeyPublished: published,
      userId: "@bot:example.org",
      userSigningKeyPublished: published,
    };
  }

  it("points encryption guidance at the selected Matrix account", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(
      listMatrixVerifications({ cfg: loadConfigMock(), accountId: "ops" }),
    ).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses the resolved default Matrix account when accountId is omitted", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          defaultAccount: "ops",
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ cfg: loadConfigMock() })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
  });

  it("uses explicit cfg instead of runtime config when crypto is unavailable", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: false,
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("verification actions should not reload runtime config when cfg is provided");
    });
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto: null });
    });

    await expect(listMatrixVerifications({ cfg: explicitCfg, accountId: "ops" })).rejects.toThrow(
      "Matrix encryption is not available (enable channels.matrix.accounts.ops.encryption=true)",
    );
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("prepares local crypto before resolving authoritative verification status", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const getOwnDeviceVerificationStatus = vi.fn().mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: "SSSS",
      backupVersion: "11",
      backup: {
        serverVersion: "11",
        activeVersion: "11",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
      serverDeviceKnown: true,
    });
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        prepareForOneOff,
        crypto: {
          listVerifications: vi.fn(async () => []),
          getRecoveryKey: vi.fn(async () => ({
            encodedPrivateKey: "rec-key",
          })),
        },
        getOwnDeviceVerificationStatus,
        start,
      });
    });

    const status = await getMatrixVerificationStatus({ includeRecoveryKey: true });

    expect(status.verified).toBe(true);
    expect(status.pendingVerifications).toBe(0);
    expect("recoveryKey" in status ? status.recoveryKey : undefined).toBe("rec-key");
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expectResolvedActionClientReadinessNone();
    expect(prepareForOneOff).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("fails closed before local Matrix prep when the current device is gone", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const getOwnDeviceVerificationStatus = vi.fn(async () => ({
      encryptionEnabled: true,
      verified: false,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      localVerified: false,
      crossSigningVerified: false,
      signedByOwner: false,
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: "SSSS",
      backupVersion: "11",
      backup: {
        serverVersion: "11",
        activeVersion: "11",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
      serverDeviceKnown: false,
    }));
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        crypto: {
          listVerifications: vi.fn(async () => []),
        },
        getOwnDeviceVerificationStatus,
        prepareForOneOff,
      });
    });

    const status = await getMatrixVerificationStatus();

    expect(status.deviceId).toBe("DEVICE123");
    expect(status.serverDeviceKnown).toBe(false);
    expect(status.pendingVerifications).toBe(0);
    expectResolvedActionClientReadinessNone();
    expect(prepareForOneOff).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("resolves encryption and backup status without starting the Matrix client", async () => {
    withResolvedActionClientMock
      .mockImplementationOnce(async (_opts, run) => {
        return await run({
          crypto: {
            getRecoveryKey: vi.fn(async () => ({
              encodedPrivateKey: "rec-key",
              createdAt: "2026-01-01T00:00:00.000Z",
            })),
            listVerifications: vi.fn(async () => [{ id: "req-1" }]),
          },
        });
      })
      .mockImplementationOnce(async (_opts, run) => {
        return await run({
          getRoomKeyBackupStatus: vi.fn(async () => ({
            serverVersion: "11",
            activeVersion: "11",
            trusted: true,
            matchesDecryptionKey: true,
            decryptionKeyCached: true,
            keyLoadAttempted: false,
            keyLoadError: null,
          })),
        });
      });

    const encryption = await getMatrixEncryptionStatus({ includeRecoveryKey: true });
    const backup = await getMatrixRoomKeyBackupStatus();

    expect(encryption.encryptionEnabled).toBe(true);
    expect(encryption.recoveryKeyStored).toBe(true);
    expect(encryption.recoveryKey).toBe("rec-key");
    expect(encryption.pendingVerifications).toBe(1);
    expect(backup.serverVersion).toBe("11");
    expect(backup.trusted).toBe(true);
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("restores room-key backup without startup crypto auto-repair", async () => {
    const restoreRoomKeyBackup = vi.fn(async () => ({
      success: true,
      imported: 1,
      total: 1,
    }));
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ restoreRoomKeyBackup });
    });

    const restored = await restoreMatrixRoomKeyBackup({ recoveryKey: " key " });

    expect(restored.success).toBe(true);
    expect(restoreRoomKeyBackup).toHaveBeenCalledWith({ recoveryKey: "key" });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });

  it("rehydrates DM verification requests before follow-up actions", async () => {
    const tracked = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "txn-dm",
    };
    const started = {
      ...tracked,
      chosenMethod: "m.sas.v1",
      phaseName: "started",
    };
    const crypto = {
      ensureVerificationDmTracked: vi.fn(async () => tracked),
      startVerification: vi.fn(async () => started),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    const result = await startMatrixVerification("txn-dm", {
      verificationDmRoomId: "!dm:example.org",
      verificationDmUserId: "@alice:example.org",
    });

    expect(result.id).toBe("verification-1");
    expect(result.phaseName).toBe("started");

    expect(crypto.ensureVerificationDmTracked).toHaveBeenCalledWith({
      roomId: "!dm:example.org",
      userId: "@alice:example.org",
    });
    expect(crypto.startVerification).toHaveBeenCalledWith("txn-dm", "sas");
  });

  it("requires complete DM lookup details for verification follow-up actions", async () => {
    const crypto = {
      ensureVerificationDmTracked: vi.fn(),
      startVerification: vi.fn(),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      startMatrixVerification("txn-dm", {
        verificationDmRoomId: "!dm:example.org",
      }),
    ).rejects.toThrow("--user-id and --room-id must be provided together");

    expect(crypto.ensureVerificationDmTracked).not.toHaveBeenCalled();
    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("keeps self-verification in one started Matrix client session", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const ready = {
      ...requested,
      phaseName: "ready",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        emoji: [["🐶", "Dog"]],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const listVerifications = vi
      .fn()
      .mockResolvedValueOnce([ready])
      .mockResolvedValueOnce([completed]);
    const crypto = {
      confirmVerificationSas: vi.fn(async () => sas),
      listVerifications,
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const confirmSas = vi.fn(async () => true);
    const getOwnDeviceVerificationStatus = vi.fn(async () => mockVerifiedOwnerStatus());
    const getOwnCrossSigningPublicationStatus = vi.fn(async () =>
      mockCrossSigningPublicationStatus(),
    );
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus,
        getOwnDeviceVerificationStatus,
      });
    });

    const result = await runMatrixSelfVerification({ confirmSas, timeoutMs: 500 });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);
    expect(result.id).toBe("verification-1");
    expect((result.ownerVerification as { verified?: unknown } | undefined)?.verified).toBe(true);

    expect(withStartedActionClientMock).toHaveBeenCalledTimes(1);
    expect(crypto.requestVerification).toHaveBeenCalledWith({ ownUser: true });
    expect(crypto.startVerification).toHaveBeenCalledWith("verification-1", "sas");
    expect(confirmSas).toHaveBeenCalledWith(sas.sas, sas);
    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-1");
    expect(bootstrapOwnDeviceVerification).not.toHaveBeenCalled();
    expect(getOwnCrossSigningPublicationStatus).toHaveBeenCalledTimes(1);
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("does not complete self-verification until the OpenClaw device has full Matrix identity trust", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const getOwnDeviceVerificationStatus = vi
      .fn()
      .mockResolvedValueOnce(mockUnverifiedOwnerStatus())
      .mockResolvedValueOnce(mockVerifiedOwnerStatus());
    const getOwnCrossSigningPublicationStatus = vi.fn(async () =>
      mockCrossSigningPublicationStatus(),
    );
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: true,
      verification: mockUnverifiedOwnerStatus(),
    }));
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus,
        getOwnDeviceVerificationStatus,
        trustOwnIdentityAfterSelfVerification,
      });
    });

    const result = await runMatrixSelfVerification({
      confirmSas: vi.fn(async () => true),
      timeoutMs: 500,
    });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);
    expect((result.ownerVerification as { verified?: unknown } | undefined)?.verified).toBe(true);

    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
    expect(getOwnCrossSigningPublicationStatus).toHaveBeenCalledTimes(2);
    expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(1);
  });

  it("does not let the SDK identity-only status read hang completed self-verification", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const getOwnDeviceIdentityVerificationStatus = vi.fn(
      async () => await new Promise<never>(() => undefined),
    );
    const getOwnDeviceVerificationStatus = vi.fn(async () => mockVerifiedOwnerStatus());
    const getOwnCrossSigningPublicationStatus = vi.fn(async () =>
      mockCrossSigningPublicationStatus(),
    );
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: true,
      verification: mockUnverifiedOwnerStatus(),
    }));
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus,
        getOwnDeviceIdentityVerificationStatus,
        getOwnDeviceVerificationStatus,
        trustOwnIdentityAfterSelfVerification,
      });
    });

    const result = await runMatrixSelfVerification({
      confirmSas: vi.fn(async () => true),
      timeoutMs: 500,
    });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);

    expect(getOwnDeviceIdentityVerificationStatus).not.toHaveBeenCalled();
    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("does not complete self-verification until cross-signing keys are published", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const getOwnDeviceVerificationStatus = vi.fn(async () => mockVerifiedOwnerStatus());
    const getOwnCrossSigningPublicationStatus = vi
      .fn()
      .mockResolvedValueOnce(mockCrossSigningPublicationStatus(false))
      .mockResolvedValueOnce(mockCrossSigningPublicationStatus(true));
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(false),
      success: false,
      verification: mockVerifiedOwnerStatus(),
    }));
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus,
        getOwnDeviceVerificationStatus,
        trustOwnIdentityAfterSelfVerification,
      });
    });

    const result = await runMatrixSelfVerification({
      confirmSas: vi.fn(async () => true),
      timeoutMs: 500,
    });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);
    expect((result.ownerVerification as { verified?: unknown } | undefined)?.verified).toBe(true);

    expect(getOwnDeviceVerificationStatus).toHaveBeenCalledTimes(2);
    expect(getOwnCrossSigningPublicationStatus).toHaveBeenCalledTimes(2);
    expect(trustOwnIdentityAfterSelfVerification).not.toHaveBeenCalled();
  });

  it("waits for SAS data without restarting an already-started self-verification", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const started = {
      ...requested,
      phaseName: "started",
    };
    const sas = {
      ...started,
      hasSas: true,
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn().mockResolvedValueOnce([started]).mockResolvedValueOnce([sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus: vi.fn(async () => mockCrossSigningPublicationStatus()),
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    const result = await runMatrixSelfVerification({
      confirmSas: vi.fn(async () => true),
      timeoutMs: 500,
    });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);

    expect(crypto.startVerification).not.toHaveBeenCalled();
  });

  it("fails immediately when an already-started self-verification uses a non-SAS method", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const started = {
      ...requested,
      chosenMethod: "m.reciprocate.v1",
      phaseName: "started",
    };
    const cancelled = {
      ...started,
      phaseName: "cancelled",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => cancelled),
      listVerifications: vi.fn(async () => [started]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).rejects.toThrow(
      "Matrix self-verification started without SAS while waiting to show SAS emoji or decimals (method: m.reciprocate.v1)",
    );

    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expect(crypto.startVerification).not.toHaveBeenCalled();
    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("finalizes completed non-SAS self-verification without waiting for SAS", async () => {
    const completed = {
      completed: true,
      hasSas: false,
      id: "verification-1",
      phaseName: "done",
      transactionId: "tx-self",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => completed),
      startVerification: vi.fn(),
    };
    const confirmSas = vi.fn(async () => true);
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: true,
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus: vi.fn(async () => mockCrossSigningPublicationStatus()),
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    const result = await runMatrixSelfVerification({ confirmSas, timeoutMs: 500 });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);
    expect(result.id).toBe("verification-1");

    expect(crypto.listVerifications).not.toHaveBeenCalled();
    expect(crypto.startVerification).not.toHaveBeenCalled();
    expect(crypto.confirmVerificationSas).not.toHaveBeenCalled();
    expect(confirmSas).not.toHaveBeenCalled();
  });

  it("allows completed self-verification when only backup health remains degraded", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(),
      success: false,
      error: "Matrix room key backup is not trusted by this device",
      verification: mockVerifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus: vi.fn(async () => mockCrossSigningPublicationStatus()),
        getOwnDeviceVerificationStatus: vi.fn(async () => mockVerifiedOwnerStatus()),
      });
    });

    const result = await runMatrixSelfVerification({
      confirmSas: vi.fn(async () => true),
      timeoutMs: 500,
    });

    expect(result.completed).toBe(true);
    expect(result.deviceOwnerVerified).toBe(true);
  });

  it("fails self-verification if SAS completes but full identity trust cannot be established", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const sas = {
      ...requested,
      hasSas: true,
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
    };
    const completed = {
      ...sas,
      completed: true,
      phaseName: "done",
    };
    const crypto = {
      cancelVerification: vi.fn(),
      confirmVerificationSas: vi.fn(async () => completed),
      listVerifications: vi.fn(async () => [sas]),
      requestVerification: vi.fn(async () => requested),
      startVerification: vi.fn(async () => sas),
    };
    const bootstrapOwnDeviceVerification = vi.fn(async () => ({
      crossSigning: mockCrossSigningPublicationStatus(false),
      success: false,
      error: "cross-signing identity is still not trusted",
      verification: mockUnverifiedOwnerStatus(),
    }));
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        bootstrapOwnDeviceVerification,
        crypto,
        getOwnCrossSigningPublicationStatus: vi.fn(async () =>
          mockCrossSigningPublicationStatus(false),
        ),
        getOwnDeviceVerificationStatus: vi.fn(async () => mockUnverifiedOwnerStatus()),
      });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 30 }),
    ).rejects.toThrow(
      "Timed out waiting for Matrix self-verification to establish full Matrix identity trust",
    );

    expect(crypto.cancelVerification).not.toHaveBeenCalled();
    expect(bootstrapOwnDeviceVerification).not.toHaveBeenCalled();
  });

  it("cancels the pending self-verification request when acceptance times out", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => requested),
      listVerifications: vi.fn(async () => []),
      requestVerification: vi.fn(async () => requested),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 30 }),
    ).rejects.toThrow("Timed out waiting for Matrix self-verification to be accepted");

    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("fails immediately when the self-verification request is cancelled while waiting", async () => {
    const requested = {
      completed: false,
      hasSas: false,
      id: "verification-1",
      phaseName: "requested",
      transactionId: "tx-self",
    };
    const cancelled = {
      ...requested,
      error: "Remote cancelled",
      pending: false,
      phaseName: "cancelled",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => cancelled),
      listVerifications: vi.fn(async () => [cancelled]),
      requestVerification: vi.fn(async () => requested),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => true), timeoutMs: 500 }),
    ).rejects.toThrow("Matrix self-verification was cancelled: Remote cancelled");

    expect(crypto.listVerifications).toHaveBeenCalledTimes(1);
    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("cancels the request when SAS mismatch submission fails", async () => {
    const sas = {
      completed: false,
      hasSas: true,
      id: "verification-1",
      phaseName: "started",
      sas: {
        decimal: [1, 2, 3],
      },
      transactionId: "tx-self",
    };
    const crypto = {
      cancelVerification: vi.fn(async () => sas),
      listVerifications: vi.fn(async () => [sas]),
      mismatchVerificationSas: vi.fn(async () => {
        throw new Error("failed to send SAS mismatch");
      }),
      requestVerification: vi.fn(async () => sas),
    };
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto });
    });

    await expect(
      runMatrixSelfVerification({ confirmSas: vi.fn(async () => false), timeoutMs: 500 }),
    ).rejects.toThrow("failed to send SAS mismatch");

    expect(crypto.cancelVerification).toHaveBeenCalledWith("verification-1", {
      code: "m.user",
      reason: "OpenClaw self-verification did not complete",
    });
  });

  it("confirmMatrixVerificationSas calls trustOwnIdentityAfterSelfVerification on a self-verification", async () => {
    const crypto = {
      confirmVerificationSas: vi.fn(async () => ({
        completed: true,
        hasSas: true,
        id: "verification-self",
        isSelfVerification: true,
        phaseName: "done",
        transactionId: "tx-self",
      })),
    };
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto, trustOwnIdentityAfterSelfVerification });
    });

    const summary = await confirmMatrixVerificationSas("verification-self");

    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-self");
    expect(trustOwnIdentityAfterSelfVerification).toHaveBeenCalledTimes(1);
    expect(summary.isSelfVerification).toBe(true);
  });

  it("confirmMatrixVerificationSas does not call trustOwnIdentityAfterSelfVerification on a non-self verification", async () => {
    const crypto = {
      confirmVerificationSas: vi.fn(async () => ({
        completed: true,
        hasSas: true,
        id: "verification-remote",
        isSelfVerification: false,
        phaseName: "done",
        transactionId: "tx-remote",
      })),
    };
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto, trustOwnIdentityAfterSelfVerification });
    });

    const summary = await confirmMatrixVerificationSas("verification-remote");

    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-remote");
    expect(trustOwnIdentityAfterSelfVerification).not.toHaveBeenCalled();
    expect(summary.isSelfVerification).toBe(false);
  });

  it("confirmMatrixVerificationSas does not trust own identity when self-verification failed", async () => {
    const crypto = {
      confirmVerificationSas: vi.fn(async () => ({
        completed: false,
        error: "verifier rejected mid-protocol",
        hasSas: true,
        id: "verification-self",
        isSelfVerification: true,
        phaseName: "started",
        transactionId: "tx-self",
      })),
    };
    const trustOwnIdentityAfterSelfVerification = vi.fn(async () => {});
    withStartedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ crypto, trustOwnIdentityAfterSelfVerification });
    });

    const summary = await confirmMatrixVerificationSas("verification-self");

    expect(crypto.confirmVerificationSas).toHaveBeenCalledWith("verification-self");
    expect(trustOwnIdentityAfterSelfVerification).not.toHaveBeenCalled();
    expect(summary.error).toMatch(/verifier rejected mid-protocol/);
  });
});
