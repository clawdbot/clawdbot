import { Command } from "commander";
import { formatZonedTimestamp } from "openclaw/plugin-sdk/matrix-runtime-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli, resetMatrixCliStateForTests } from "./cli.js";

const bootstrapMatrixVerificationMock = vi.fn();
const getMatrixRoomKeyBackupStatusMock = vi.fn();
const getMatrixVerificationStatusMock = vi.fn();
const listMatrixOwnDevicesMock = vi.fn();
const pruneMatrixStaleGatewayDevicesMock = vi.fn();
const resolveMatrixAccountConfigMock = vi.fn();
const resolveMatrixAccountMock = vi.fn();
const resolveMatrixAuthContextMock = vi.fn();
const matrixSetupApplyAccountConfigMock = vi.fn();
const matrixSetupValidateInputMock = vi.fn();
const matrixRuntimeLoadConfigMock = vi.fn();
const matrixRuntimeWriteConfigFileMock = vi.fn();
const resetMatrixRoomKeyBackupMock = vi.fn();
const restoreMatrixRoomKeyBackupMock = vi.fn();
const setMatrixSdkConsoleLoggingMock = vi.fn();
const setMatrixSdkLogModeMock = vi.fn();
const updateMatrixOwnProfileMock = vi.fn();
const verifyMatrixRecoveryKeyMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();

vi.mock("./matrix/actions/verification.js", () => ({
  bootstrapMatrixVerification: (...args: unknown[]) => bootstrapMatrixVerificationMock(...args),
  getMatrixRoomKeyBackupStatus: (...args: unknown[]) => getMatrixRoomKeyBackupStatusMock(...args),
  getMatrixVerificationStatus: (...args: unknown[]) => getMatrixVerificationStatusMock(...args),
  resetMatrixRoomKeyBackup: (...args: unknown[]) => resetMatrixRoomKeyBackupMock(...args),
  restoreMatrixRoomKeyBackup: (...args: unknown[]) => restoreMatrixRoomKeyBackupMock(...args),
  verifyMatrixRecoveryKey: (...args: unknown[]) => verifyMatrixRecoveryKeyMock(...args),
}));

vi.mock("./matrix/actions/devices.js", () => ({
  listMatrixOwnDevices: (...args: unknown[]) => listMatrixOwnDevicesMock(...args),
  pruneMatrixStaleGatewayDevices: (...args: unknown[]) =>
    pruneMatrixStaleGatewayDevicesMock(...args),
}));

vi.mock("./matrix/client/logging.js", () => ({
  setMatrixSdkConsoleLogging: (...args: unknown[]) => setMatrixSdkConsoleLoggingMock(...args),
  setMatrixSdkLogMode: (...args: unknown[]) => setMatrixSdkLogModeMock(...args),
}));

vi.mock("./matrix/actions/profile.js", () => ({
  updateMatrixOwnProfile: (...args: unknown[]) => updateMatrixOwnProfileMock(...args),
}));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccount: (...args: unknown[]) => resolveMatrixAccountMock(...args),
  resolveMatrixAccountConfig: (...args: unknown[]) => resolveMatrixAccountConfigMock(...args),
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuthContext: (...args: unknown[]) => resolveMatrixAuthContextMock(...args),
}));

vi.mock("./setup-core.js", () => ({
  matrixSetupAdapter: {
    applyAccountConfig: (...args: unknown[]) => matrixSetupApplyAccountConfigMock(...args),
    validateInput: (...args: unknown[]) => matrixSetupValidateInputMock(...args),
  },
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      loadConfig: (...args: unknown[]) => matrixRuntimeLoadConfigMock(...args),
      writeConfigFile: (...args: unknown[]) => matrixRuntimeWriteConfigFileMock(...args),
    },
  }),
}));

function buildProgram(): Command {
  const program = new Command();
  registerMatrixCli({ program });
  return program;
}

function formatExpectedLocalTimestamp(value: string): string {
  return formatZonedTimestamp(new Date(value), { displaySeconds: true }) ?? value;
}

function mockMatrixVerificationStatus(params: {
  recoveryKeyCreatedAt: string | null;
  verifiedAt?: string;
}) {
  getMatrixVerificationStatusMock.mockResolvedValue({
    encryptionEnabled: true,
    verified: true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    backupVersion: "1",
    backup: {
      serverVersion: "1",
      activeVersion: "1",
      trusted: true,
      matchesDecryptionKey: true,
      decryptionKeyCached: true,
    },
    recoveryKeyStored: true,
    recoveryKeyCreatedAt: params.recoveryKeyCreatedAt,
    pendingVerifications: 0,
    verifiedAt: params.verifiedAt,
  });
}

describe("matrix CLI verification commands", () => {
  beforeEach(() => {
    resetMatrixCliStateForTests();
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => consoleLogMock(...args));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) =>
      consoleErrorMock(...args),
    );
    consoleLogMock.mockReset();
    consoleErrorMock.mockReset();
    matrixSetupValidateInputMock.mockReturnValue(null);
    matrixSetupApplyAccountConfigMock.mockImplementation(({ cfg }: { cfg: unknown }) => cfg);
    matrixRuntimeLoadConfigMock.mockReturnValue({});
    matrixRuntimeWriteConfigFileMock.mockResolvedValue(undefined);
    resolveMatrixAuthContextMock.mockImplementation(
      ({ cfg, accountId }: { cfg: unknown; accountId?: string | null }) => ({
        cfg,
        env: process.env,
        accountId: accountId ?? "default",
        resolved: {},
      }),
    );
    resolveMatrixAccountMock.mockReturnValue({
      configured: false,
    });
    resolveMatrixAccountConfigMock.mockReturnValue({
      encryption: false,
    });
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {
        recoveryKeyCreatedAt: null,
        backupVersion: null,
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    resetMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      previousVersion: "1",
      deletedVersion: "1",
      createdVersion: "2",
      backup: {
        serverVersion: "2",
        activeVersion: "2",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
    });
    updateMatrixOwnProfileMock.mockResolvedValue({
      skipped: false,
      displayNameUpdated: true,
      avatarUpdated: false,
      resolvedAvatarUrl: null,
      convertedAvatarFromHttp: false,
    });
    listMatrixOwnDevicesMock.mockResolvedValue([]);
    pruneMatrixStaleGatewayDevicesMock.mockResolvedValue({
      before: [],
      staleGatewayDeviceIds: [],
      currentDeviceId: null,
      deletedDeviceIds: [],
      remainingDevices: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets non-zero exit code for device verification failures in JSON mode", async () => {
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      success: false,
      error: "invalid key",
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "device", "bad-key", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
  });

  it("sets non-zero exit code for bootstrap failures in JSON mode", async () => {
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: false,
      error: "bootstrap failed",
      verification: {},
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: null,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "bootstrap", "--json"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("sets non-zero exit code for backup restore failures in JSON mode", async () => {
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: false,
      error: "missing backup key",
      backupVersion: null,
      imported: 0,
      total: 0,
      loadedFromSecretStorage: false,
      backup: {
        serverVersion: "1",
        activeVersion: null,
        trusted: true,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
      },
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "restore", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
  });

  it("sets non-zero exit code for backup reset failures in JSON mode", async () => {
    resetMatrixRoomKeyBackupMock.mockResolvedValue({
      success: false,
      error: "reset failed",
      previousVersion: "1",
      deletedVersion: "1",
      createdVersion: null,
      backup: {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "reset", "--yes", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
  });

  it("lists matrix devices", async () => {
    listMatrixOwnDevicesMock.mockResolvedValue([
      {
        deviceId: "A7hWrQ70ea",
        displayName: "OpenClaw Gateway",
        lastSeenIp: "127.0.0.1",
        lastSeenTs: 1_741_507_200_000,
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "OpenClaw Gateway",
        lastSeenIp: null,
        lastSeenTs: null,
        current: false,
      },
    ]);
    const program = buildProgram();

    await program.parseAsync(["matrix", "devices", "list", "--account", "poe"], { from: "user" });

    expect(listMatrixOwnDevicesMock).toHaveBeenCalledWith({ accountId: "poe" });
    expect(console.log).toHaveBeenCalledWith("Account: poe");
    expect(console.log).toHaveBeenCalledWith("- A7hWrQ70ea (current, OpenClaw Gateway)");
    expect(console.log).toHaveBeenCalledWith("  Last IP: 127.0.0.1");
    expect(console.log).toHaveBeenCalledWith("- BritdXC6iL (OpenClaw Gateway)");
  });

  it("prunes stale matrix gateway devices", async () => {
    pruneMatrixStaleGatewayDevicesMock.mockResolvedValue({
      before: [
        {
          deviceId: "A7hWrQ70ea",
          displayName: "OpenClaw Gateway",
          lastSeenIp: "127.0.0.1",
          lastSeenTs: 1_741_507_200_000,
          current: true,
        },
        {
          deviceId: "BritdXC6iL",
          displayName: "OpenClaw Gateway",
          lastSeenIp: null,
          lastSeenTs: null,
          current: false,
        },
      ],
      staleGatewayDeviceIds: ["BritdXC6iL"],
      currentDeviceId: "A7hWrQ70ea",
      deletedDeviceIds: ["BritdXC6iL"],
      remainingDevices: [
        {
          deviceId: "A7hWrQ70ea",
          displayName: "OpenClaw Gateway",
          lastSeenIp: "127.0.0.1",
          lastSeenTs: 1_741_507_200_000,
          current: true,
        },
      ],
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "devices", "prune-stale", "--account", "poe"], {
      from: "user",
    });

    expect(pruneMatrixStaleGatewayDevicesMock).toHaveBeenCalledWith({ accountId: "poe" });
    expect(console.log).toHaveBeenCalledWith("Deleted stale OpenClaw devices: BritdXC6iL");
    expect(console.log).toHaveBeenCalledWith("Current device: A7hWrQ70ea");
    expect(console.log).toHaveBeenCalledWith("Remaining devices: 1");
  });

  it("adds a matrix account and prints a binding hint", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    matrixSetupApplyAccountConfigMock.mockImplementation(
      ({ cfg, accountId }: { cfg: Record<string, unknown>; accountId: string }) => ({
        ...cfg,
        channels: {
          ...(cfg.channels as Record<string, unknown> | undefined),
          matrix: {
            accounts: {
              [accountId]: {
                homeserver: "https://matrix.example.org",
              },
            },
          },
        },
      }),
    );
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--account",
        "Ops",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@ops:example.org",
        "--password",
        "secret",
      ],
      { from: "user" },
    );

    expect(matrixSetupValidateInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        input: expect.objectContaining({
          homeserver: "https://matrix.example.org",
          userId: "@ops:example.org",
          password: "secret", // pragma: allowlist secret
        }),
      }),
    );
    expect(matrixRuntimeWriteConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          matrix: {
            accounts: {
              ops: expect.objectContaining({
                homeserver: "https://matrix.example.org",
              }),
            },
          },
        },
      }),
    );
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops");
    expect(console.log).toHaveBeenCalledWith(
      "Bind this account to an agent: openclaw agents bind --agent <id> --bind matrix:ops",
    );
  });

  it("bootstraps verification for newly added encrypted accounts", async () => {
    resolveMatrixAccountConfigMock.mockReturnValue({
      encryption: true,
    });
    listMatrixOwnDevicesMock.mockResolvedValue([
      {
        deviceId: "BritdXC6iL",
        displayName: "OpenClaw Gateway",
        lastSeenIp: null,
        lastSeenTs: null,
        current: false,
      },
      {
        deviceId: "du314Zpw3A",
        displayName: "OpenClaw Gateway",
        lastSeenIp: null,
        lastSeenTs: null,
        current: true,
      },
    ]);
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {
        recoveryKeyCreatedAt: "2026-03-09T06:00:00.000Z",
        backupVersion: "7",
      },
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--account",
        "ops",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@ops:example.org",
        "--password",
        "secret",
      ],
      { from: "user" },
    );

    expect(bootstrapMatrixVerificationMock).toHaveBeenCalledWith({ accountId: "ops" });
    expect(console.log).toHaveBeenCalledWith("Matrix verification bootstrap: complete");
    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp("2026-03-09T06:00:00.000Z")}`,
    );
    expect(console.log).toHaveBeenCalledWith("Backup version: 7");
    expect(console.log).toHaveBeenCalledWith(
      "Matrix device hygiene warning: stale OpenClaw devices detected (BritdXC6iL). Run 'openclaw matrix devices prune-stale --account ops'.",
    );
  });

  it("does not bootstrap verification when updating an already configured account", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              enabled: true,
              homeserver: "https://matrix.example.org",
            },
          },
        },
      },
    });
    resolveMatrixAccountConfigMock.mockReturnValue({
      encryption: true,
    });
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--account",
        "ops",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@ops:example.org",
        "--password",
        "secret",
      ],
      { from: "user" },
    );

    expect(bootstrapMatrixVerificationMock).not.toHaveBeenCalled();
  });

  it("warns instead of failing when device-health probing fails after saving the account", async () => {
    listMatrixOwnDevicesMock.mockRejectedValue(new Error("homeserver unavailable"));
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--account",
        "ops",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@ops:example.org",
        "--password",
        "secret",
      ],
      { from: "user" },
    );

    expect(matrixRuntimeWriteConfigFileMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops");
    expect(console.error).toHaveBeenCalledWith(
      "Matrix device health warning: homeserver unavailable",
    );
  });

  it("returns device-health warnings in JSON mode without failing the account add command", async () => {
    listMatrixOwnDevicesMock.mockRejectedValue(new Error("homeserver unavailable"));
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--account",
        "ops",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@ops:example.org",
        "--password",
        "secret",
        "--json",
      ],
      { from: "user" },
    );

    expect(matrixRuntimeWriteConfigFileMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const jsonOutput = consoleLogMock.mock.calls.at(-1)?.[0];
    expect(typeof jsonOutput).toBe("string");
    expect(JSON.parse(String(jsonOutput))).toEqual(
      expect.objectContaining({
        accountId: "ops",
        deviceHealth: expect.objectContaining({
          currentDeviceId: null,
          staleOpenClawDeviceIds: [],
          error: "homeserver unavailable",
        }),
      }),
    );
  });

  it("uses --name as fallback account id and prints account-scoped config path", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--name",
        "Main Bot",
        "--homeserver",
        "https://matrix.example.org",
        "--user-id",
        "@main:example.org",
        "--password",
        "secret",
      ],
      { from: "user" },
    );

    expect(matrixSetupValidateInputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main-bot",
      }),
    );
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: main-bot");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.main-bot");
    expect(updateMatrixOwnProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main-bot",
        displayName: "Main Bot",
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      "Bind this account to an agent: openclaw agents bind --agent <id> --bind matrix:main-bot",
    );
  });

  it("forwards --avatar-url through account add setup and profile sync", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "account",
        "add",
        "--name",
        "Ops Bot",
        "--homeserver",
        "https://matrix.example.org",
        "--access-token",
        "ops-token",
        "--avatar-url",
        "mxc://example/ops-avatar",
      ],
      { from: "user" },
    );

    expect(matrixSetupApplyAccountConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops-bot",
        input: expect.objectContaining({
          name: "Ops Bot",
          homeserver: "https://matrix.example.org",
          accessToken: "ops-token",
          avatarUrl: "mxc://example/ops-avatar",
        }),
      }),
    );
    expect(updateMatrixOwnProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops-bot",
        displayName: "Ops Bot",
        avatarUrl: "mxc://example/ops-avatar",
      }),
    );
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops-bot");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.ops-bot");
  });

  it("sets profile name and avatar via profile set command", async () => {
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "profile",
        "set",
        "--account",
        "alerts",
        "--name",
        "Alerts Bot",
        "--avatar-url",
        "mxc://example/avatar",
      ],
      { from: "user" },
    );

    expect(updateMatrixOwnProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "alerts",
        displayName: "Alerts Bot",
        avatarUrl: "mxc://example/avatar",
      }),
    );
    expect(matrixRuntimeWriteConfigFileMock).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("Account: alerts");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.alerts");
  });

  it("returns JSON errors for invalid account setup input", async () => {
    matrixSetupValidateInputMock.mockReturnValue("Matrix requires --homeserver");
    const program = buildProgram();

    await program.parseAsync(["matrix", "account", "add", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"error": "Matrix requires --homeserver"'),
    );
  });

  it("keeps zero exit code for successful bootstrap in JSON mode", async () => {
    process.exitCode = 0;
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {},
      crossSigning: {},
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "bootstrap", "--json"], { from: "user" });

    expect(process.exitCode).toBe(0);
  });

  it("prints local timezone timestamps for verify status output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: recoveryCreatedAt });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status", "--verbose"], { from: "user" });

    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).toHaveBeenCalledWith("Diagnostics:");
    expect(console.log).toHaveBeenCalledWith("Locally trusted: yes");
    expect(console.log).toHaveBeenCalledWith("Signed by owner: yes");
    expect(setMatrixSdkLogModeMock).toHaveBeenCalledWith("default");
  });

  it("prints local timezone timestamps for verify bootstrap and device output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    const verifiedAt = "2026-02-25T20:14:00.000Z";
    bootstrapMatrixVerificationMock.mockResolvedValue({
      success: true,
      verification: {
        encryptionEnabled: true,
        verified: true,
        userId: "@bot:example.org",
        deviceId: "DEVICE123",
        backupVersion: "1",
        backup: {
          serverVersion: "1",
          activeVersion: "1",
          trusted: true,
          matchesDecryptionKey: true,
          decryptionKeyCached: true,
        },
        recoveryKeyStored: true,
        recoveryKeyId: "SSSS",
        recoveryKeyCreatedAt: recoveryCreatedAt,
        localVerified: true,
        crossSigningVerified: true,
        signedByOwner: true,
      },
      crossSigning: {
        published: true,
        masterKeyPublished: true,
        selfSigningKeyPublished: true,
        userSigningKeyPublished: true,
      },
      pendingVerifications: 0,
      cryptoBootstrap: {},
    });
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      success: true,
      encryptionEnabled: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "1",
      backup: {
        serverVersion: "1",
        activeVersion: "1",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
      },
      verified: true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      recoveryKeyStored: true,
      recoveryKeyId: "SSSS",
      recoveryKeyCreatedAt: recoveryCreatedAt,
      verifiedAt,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "bootstrap", "--verbose"], {
      from: "user",
    });
    await program.parseAsync(["matrix", "verify", "device", "valid-key", "--verbose"], {
      from: "user",
    });

    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).toHaveBeenCalledWith(
      `Verified at: ${formatExpectedLocalTimestamp(verifiedAt)}`,
    );
  });

  it("keeps default output concise when verbose is not provided", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: recoveryCreatedAt });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(console.log).not.toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).not.toHaveBeenCalledWith("Pending verifications: 0");
    expect(console.log).not.toHaveBeenCalledWith("Diagnostics:");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
    expect(setMatrixSdkLogModeMock).toHaveBeenCalledWith("quiet");
  });

  it("shows explicit backup issue in default status output", async () => {
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "5256",
      backup: {
        serverVersion: "5256",
        activeVersion: null,
        trusted: true,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
        keyLoadError: null,
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(console.log).toHaveBeenCalledWith(
      "Backup issue: backup decryption key is not loaded on this device (secret storage did not return a key)",
    );
    expect(console.log).toHaveBeenCalledWith(
      "- Backup key is not loaded on this device. Run 'openclaw matrix verify backup restore' to load it and restore old room keys.",
    );
    expect(console.log).not.toHaveBeenCalledWith(
      "- Backup is present but not trusted for this device. Re-run 'openclaw matrix verify device <key>'.",
    );
  });

  it("includes key load failure details in status output", async () => {
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "5256",
      backup: {
        serverVersion: "5256",
        activeVersion: null,
        trusted: true,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
        keyLoadError: "secret storage key is not available",
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(console.log).toHaveBeenCalledWith(
      "Backup issue: backup decryption key could not be loaded from secret storage (secret storage key is not available)",
    );
  });

  it("includes backup reset guidance when the backup key does not match this device", async () => {
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: true,
      localVerified: true,
      crossSigningVerified: true,
      signedByOwner: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "21868",
      backup: {
        serverVersion: "21868",
        activeVersion: "21868",
        trusted: true,
        matchesDecryptionKey: false,
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: "2026-03-09T14:40:00.000Z",
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(console.log).toHaveBeenCalledWith(
      "- If you want a fresh backup baseline and accept losing unrecoverable history, run 'openclaw matrix verify backup reset --yes'. This may also repair secret storage so the new backup key can be loaded after restart.",
    );
  });

  it("requires --yes before resetting the Matrix room-key backup", async () => {
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "reset"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(resetMatrixRoomKeyBackupMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Backup reset failed: Refusing to reset Matrix room-key backup without --yes",
    );
  });

  it("resets the Matrix room-key backup when confirmed", async () => {
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "reset", "--yes"], {
      from: "user",
    });

    expect(resetMatrixRoomKeyBackupMock).toHaveBeenCalledWith({ accountId: "default" });
    expect(console.log).toHaveBeenCalledWith("Reset success: yes");
    expect(console.log).toHaveBeenCalledWith("Previous backup version: 1");
    expect(console.log).toHaveBeenCalledWith("Deleted backup version: 1");
    expect(console.log).toHaveBeenCalledWith("Current backup version: 2");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
  });

  it("prints resolved account-aware guidance when a named Matrix account is selected implicitly", async () => {
    resolveMatrixAuthContextMock.mockImplementation(
      ({ cfg, accountId }: { cfg: unknown; accountId?: string | null }) => ({
        cfg,
        env: process.env,
        accountId: accountId ?? "assistant",
        resolved: {},
      }),
    );
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: false,
      localVerified: false,
      crossSigningVerified: false,
      signedByOwner: false,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
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
      recoveryKeyStored: false,
      recoveryKeyCreatedAt: null,
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(getMatrixVerificationStatusMock).toHaveBeenCalledWith({
      accountId: "assistant",
      includeRecoveryKey: false,
    });
    expect(console.log).toHaveBeenCalledWith("Account: assistant");
    expect(console.log).toHaveBeenCalledWith(
      "- Run 'openclaw matrix verify device <key> --account assistant' to verify this device.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "- Run 'openclaw matrix verify bootstrap --account assistant' to create a room key backup.",
    );
  });

  it("prints backup health lines for verify backup status in verbose mode", async () => {
    getMatrixRoomKeyBackupStatusMock.mockResolvedValue({
      serverVersion: "2",
      activeVersion: null,
      trusted: true,
      matchesDecryptionKey: false,
      decryptionKeyCached: false,
      keyLoadAttempted: true,
      keyLoadError: null,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "status", "--verbose"], {
      from: "user",
    });

    expect(console.log).toHaveBeenCalledWith("Backup server version: 2");
    expect(console.log).toHaveBeenCalledWith("Backup active on this device: no");
    expect(console.log).toHaveBeenCalledWith("Backup trusted by this device: yes");
  });
});
