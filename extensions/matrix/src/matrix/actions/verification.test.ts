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
      loadConfig: loadConfigMock,
    },
  }),
}));

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

let listMatrixVerifications: typeof import("./verification.js").listMatrixVerifications;
let getMatrixEncryptionStatus: typeof import("./verification.js").getMatrixEncryptionStatus;
let getMatrixRoomKeyBackupStatus: typeof import("./verification.js").getMatrixRoomKeyBackupStatus;
let getMatrixVerificationStatus: typeof import("./verification.js").getMatrixVerificationStatus;

describe("matrix verification actions", () => {
  beforeAll(async () => {
    ({
      getMatrixEncryptionStatus,
      getMatrixRoomKeyBackupStatus,
      getMatrixVerificationStatus,
      listMatrixVerifications,
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

    await expect(listMatrixVerifications({ accountId: "ops" })).rejects.toThrow(
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

    await expect(listMatrixVerifications()).rejects.toThrow(
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

  it("resolves verification status without starting the Matrix client", async () => {
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({
        crypto: {
          listVerifications: vi.fn(async () => []),
          getRecoveryKey: vi.fn(async () => ({
            encodedPrivateKey: "rec-key",
          })),
        },
        getOwnDeviceVerificationStatus: vi.fn(async () => ({
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
        })),
      });
    });

    const status = await getMatrixVerificationStatus({ includeRecoveryKey: true });

    expect(status).toMatchObject({
      verified: true,
      pendingVerifications: 0,
      recoveryKey: "rec-key",
    });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(1);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
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

    expect(encryption).toMatchObject({
      encryptionEnabled: true,
      recoveryKeyStored: true,
      recoveryKey: "rec-key",
      pendingVerifications: 1,
    });
    expect(backup).toMatchObject({
      serverVersion: "11",
      trusted: true,
    });
    expect(withResolvedActionClientMock).toHaveBeenCalledTimes(2);
    expect(withStartedActionClientMock).not.toHaveBeenCalled();
  });
});
