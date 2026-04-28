import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli, resetMatrixCliStateForTests } from "./cli.js";
import { formatZonedTimestamp } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const bootstrapMatrixVerificationMock = vi.fn();
const acceptMatrixVerificationMock = vi.fn();
const cancelMatrixVerificationMock = vi.fn();
const confirmMatrixVerificationSasMock = vi.fn();
const getMatrixRoomKeyBackupStatusMock = vi.fn();
const getMatrixVerificationSasMock = vi.fn();
const getMatrixVerificationStatusMock = vi.fn();
const listMatrixOwnDevicesMock = vi.fn();
const listMatrixVerificationsMock = vi.fn();
const mismatchMatrixVerificationSasMock = vi.fn();
const pruneMatrixStaleGatewayDevicesMock = vi.fn();
const requestMatrixVerificationMock = vi.fn();
const resolveMatrixAccountConfigMock = vi.fn();
const resolveMatrixAccountMock = vi.fn();
const resolveMatrixAuthContextMock = vi.fn();
const matrixSetupApplyAccountConfigMock = vi.fn();
const matrixSetupValidateInputMock = vi.fn();
const matrixRuntimeLoadConfigMock = vi.fn();
const matrixRuntimeReplaceConfigFileMock = vi.fn();
const resetMatrixRoomKeyBackupMock = vi.fn();
const restoreMatrixRoomKeyBackupMock = vi.fn();
const runMatrixSelfVerificationMock = vi.fn();
const setMatrixSdkConsoleLoggingMock = vi.fn();
const setMatrixSdkLogModeMock = vi.fn();
const startMatrixVerificationMock = vi.fn();
const updateMatrixOwnProfileMock = vi.fn();
const verifyMatrixRecoveryKeyMock = vi.fn();
const consoleLogMock = vi.fn();
const consoleErrorMock = vi.fn();
const stdoutWriteMock = vi.fn();

function mockRecoveryKeyStdin(value: string): void {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockReturnValue(
    (async function* (): AsyncGenerator<Buffer, undefined, unknown> {
      yield Buffer.from(value);
      return undefined;
    })(),
  );
}

vi.mock("./matrix/actions/verification.js", () => ({
  acceptMatrixVerification: (...args: unknown[]) => acceptMatrixVerificationMock(...args),
  bootstrapMatrixVerification: (...args: unknown[]) => bootstrapMatrixVerificationMock(...args),
  cancelMatrixVerification: (...args: unknown[]) => cancelMatrixVerificationMock(...args),
  confirmMatrixVerificationSas: (...args: unknown[]) => confirmMatrixVerificationSasMock(...args),
  getMatrixRoomKeyBackupStatus: (...args: unknown[]) => getMatrixRoomKeyBackupStatusMock(...args),
  getMatrixVerificationSas: (...args: unknown[]) => getMatrixVerificationSasMock(...args),
  getMatrixVerificationStatus: (...args: unknown[]) => getMatrixVerificationStatusMock(...args),
  listMatrixVerifications: (...args: unknown[]) => listMatrixVerificationsMock(...args),
  mismatchMatrixVerificationSas: (...args: unknown[]) => mismatchMatrixVerificationSasMock(...args),
  requestMatrixVerification: (...args: unknown[]) => requestMatrixVerificationMock(...args),
  resetMatrixRoomKeyBackup: (...args: unknown[]) => resetMatrixRoomKeyBackupMock(...args),
  restoreMatrixRoomKeyBackup: (...args: unknown[]) => restoreMatrixRoomKeyBackupMock(...args),
  runMatrixSelfVerification: (...args: unknown[]) => runMatrixSelfVerificationMock(...args),
  startMatrixVerification: (...args: unknown[]) => startMatrixVerificationMock(...args),
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
      current: (...args: unknown[]) => matrixRuntimeLoadConfigMock(...args),
      replaceConfigFile: (...args: unknown[]) => matrixRuntimeReplaceConfigFileMock(...args),
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
    serverDeviceKnown: true,
    pendingVerifications: 0,
    verifiedAt: params.verifiedAt,
  });
}

function mockMatrixVerificationSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "self-1",
    transactionId: "txn-1",
    otherUserId: "@bot:example.org",
    otherDeviceId: "PHONE123",
    isSelfVerification: true,
    initiatedByMe: true,
    phaseName: "started",
    pending: true,
    methods: ["m.sas.v1"],
    chosenMethod: "m.sas.v1",
    hasSas: true,
    sas: {
      decimal: [1234, 5678, 9012],
    },
    completed: false,
    ...overrides,
  };
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
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutWriteMock(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    consoleLogMock.mockReset();
    consoleErrorMock.mockReset();
    stdoutWriteMock.mockReset();
    matrixSetupValidateInputMock.mockReturnValue(null);
    matrixSetupApplyAccountConfigMock.mockImplementation(({ cfg }: { cfg: unknown }) => cfg);
    matrixRuntimeLoadConfigMock.mockReturnValue({});
    matrixRuntimeReplaceConfigFileMock.mockResolvedValue(undefined);
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

  it("prints recovery-key and identity-trust diagnostics for device verification failures", async () => {
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      success: false,
      error:
        "Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
      encryptionEnabled: true,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      backupVersion: "7",
      backup: {
        serverVersion: "7",
        activeVersion: "7",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
        keyLoadAttempted: true,
        keyLoadError: null,
      },
      verified: false,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: false,
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: false,
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "device", "valid-key"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Verification failed: Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith("Recovery key accepted: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup usable: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Device verified by owner: no");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup: active and trusted on this device");
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Recovery key can unlock the room-key backup, but full Matrix identity trust is still incomplete. Run openclaw matrix verify self, accept the request in another verified Matrix client, and confirm the SAS only if it matches.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- If you intend to replace the current cross-signing identity, run the shown printf pipeline with the Matrix recovery key env var for this account: printf '%s\\n' \"$MATRIX_RECOVERY_KEY\" | openclaw matrix verify bootstrap --recovery-key-stdin --force-reset-cross-signing.",
    );
  });

  it("runs interactive Matrix self-verification in one CLI flow", async () => {
    runMatrixSelfVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        completed: true,
        deviceOwnerVerified: true,
        ownerVerification: {
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
          recoveryKeyStored: true,
          signedByOwner: true,
          userId: "@bot:example.org",
          verified: true,
        },
        pending: false,
        phaseName: "done",
      }),
    );
    const program = buildProgram();

    await program.parseAsync(
      ["matrix", "verify", "self", "--account", "ops", "--timeout-ms", "5000"],
      {
        from: "user",
      },
    );

    expect(runMatrixSelfVerificationMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: {},
      timeoutMs: 5000,
      onRequested: expect.any(Function),
      onReady: expect.any(Function),
      onSas: expect.any(Function),
      confirmSas: expect.any(Function),
    });
    expect(consoleLogMock).toHaveBeenCalledWith("Self-verification complete.");
    expect(consoleLogMock).toHaveBeenCalledWith("Device verified by owner: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Cross-signing verified: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Signed by owner: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup: active and trusted on this device");
  });

  it("requests Matrix self-verification and prints the follow-up SAS commands", async () => {
    requestMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "self-verify-1",
        hasSas: false,
        sas: undefined,
      }),
    );
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "request", "--own-user", "--account", "ops"], {
      from: "user",
    });

    expect(requestMatrixVerificationMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: {},
      ownUser: true,
      userId: undefined,
      deviceId: undefined,
      roomId: undefined,
    });
    expect(consoleLogMock).toHaveBeenCalledWith("Verification id: self-verify-1");
    expect(consoleLogMock).toHaveBeenCalledWith("Transaction id: txn-1");
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Accept the verification request in another Matrix client for this account.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Then run openclaw matrix verify start --account ops -- txn-1 to start SAS verification.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Run openclaw matrix verify sas --account ops -- txn-1 to display the SAS emoji or decimals.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- When the SAS matches, run openclaw matrix verify confirm-sas --account ops -- txn-1.",
    );
  });

  it("prints DM lookup details in Matrix verification follow-up commands", async () => {
    requestMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "dm-verify-1",
        transactionId: "txn-dm",
        roomId: "!room-'$(x):example.org",
        otherUserId: "@alice:example.org",
        isSelfVerification: false,
        hasSas: false,
        sas: undefined,
      }),
    );
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "verify",
        "request",
        "--user-id",
        "@alice:example.org",
        "--room-id",
        "!room-'$(x):example.org",
      ],
      { from: "user" },
    );

    expect(requestMatrixVerificationMock).toHaveBeenCalledWith({
      accountId: "default",
      cfg: {},
      ownUser: undefined,
      userId: "@alice:example.org",
      deviceId: undefined,
      roomId: "!room-'$(x):example.org",
    });
    expect(consoleLogMock).toHaveBeenCalledWith("Room id: !room-'$(x):example.org");
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Then run openclaw matrix verify start --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm to start SAS verification.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Run openclaw matrix verify sas --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm to display the SAS emoji or decimals.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- When the SAS matches, run openclaw matrix verify confirm-sas --user-id @alice:example.org --room-id '!room-'\\''$(x):example.org' -- txn-dm.",
    );
  });

  it("terminates options before remote Matrix verification ids in follow-up commands", async () => {
    requestMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "local-id",
        transactionId: "--account=evil",
        hasSas: false,
        sas: undefined,
      }),
    );
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "request", "--own-user", "--account", "ops"], {
      from: "user",
    });

    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Then run openclaw matrix verify start --account ops -- --account=evil to start SAS verification.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Run openclaw matrix verify sas --account ops -- --account=evil to display the SAS emoji or decimals.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- When the SAS matches, run openclaw matrix verify confirm-sas --account ops -- --account=evil.",
    );
  });

  it("rejects ambiguous Matrix verification request targets", async () => {
    const program = buildProgram();

    await program.parseAsync(
      ["matrix", "verify", "request", "--own-user", "--user-id", "@other:example.org"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(requestMatrixVerificationMock).not.toHaveBeenCalled();
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Verification request failed: --own-user cannot be combined with --user-id, --device-id, or --room-id",
    );
  });

  it("lists Matrix verification requests", async () => {
    listMatrixVerificationsMock.mockResolvedValue([
      mockMatrixVerificationSummary({ id: "incoming-1", initiatedByMe: false }),
    ]);
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "list"], { from: "user" });

    expect(listMatrixVerificationsMock).toHaveBeenCalledWith({ accountId: "default", cfg: {} });
    expect(consoleLogMock).toHaveBeenCalledWith("Verification id: incoming-1");
    expect(consoleLogMock).toHaveBeenCalledWith("Initiated by OpenClaw: no");
  });

  it("sanitizes remote Matrix verification metadata before printing it", async () => {
    listMatrixVerificationsMock.mockResolvedValue([
      mockMatrixVerificationSummary({
        id: "self-\u001B[31m1",
        transactionId: "txn-\n\u009B31m1",
        otherUserId: "@bot\u001B[2J\u009Dspoof\u0007:example.org",
        otherDeviceId: "PHONE\r\u009B2J123",
        phaseName: "started\u001B[0m",
        methods: ["m.sas.v1\n\u009B31mspoof"],
        chosenMethod: "m.sas.v1\u001B[1m",
        sas: {
          emoji: [
            ["🐶", "Dog\u001B[31m\u009B2J"],
            ["🐱", "Cat\n\u009B31mspoof"],
          ],
        },
        error: "Remote\u001B[31m cancelled\n\u009B31mforged",
      }),
    ]);
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "list"], { from: "user" });

    expect(consoleLogMock).toHaveBeenCalledWith("Verification id: self-1");
    expect(consoleLogMock).toHaveBeenCalledWith("Transaction id: txn-1");
    expect(consoleLogMock).toHaveBeenCalledWith("Other user: @bot:example.org");
    expect(consoleLogMock).toHaveBeenCalledWith("Other device: PHONE123");
    expect(consoleLogMock).toHaveBeenCalledWith("Phase: started");
    expect(consoleLogMock).toHaveBeenCalledWith("Methods: m.sas.v1spoof");
    expect(consoleLogMock).toHaveBeenCalledWith("Chosen method: m.sas.v1");
    expect(consoleLogMock).toHaveBeenCalledWith("SAS emoji: 🐶 Dog | 🐱 Catspoof");
    expect(consoleLogMock).toHaveBeenCalledWith("Verification error: Remote cancelledforged");
  });

  it("sanitizes remote Matrix status metadata before printing diagnostics", async () => {
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: false,
      localVerified: false,
      crossSigningVerified: false,
      signedByOwner: false,
      userId: "@bot\u001B[2J:example.org",
      deviceId: "PHONE\r\u009B2J123",
      backupVersion: "1\u001B[31m",
      backup: {
        serverVersion: "2\u001B[31m",
        activeVersion: "1\u009B2J",
        trusted: false,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
        keyLoadError: "Remote\n\u009B31mforged",
      },
      recoveryKeyStored: false,
      recoveryKeyCreatedAt: null,
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status", "--verbose"], { from: "user" });

    expect(consoleLogMock).toHaveBeenCalledWith("User: @bot:example.org");
    expect(consoleLogMock).toHaveBeenCalledWith("Device: PHONE123");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup server version: 2");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup active on this device: 1");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup key load error: Remoteforged");
  });

  it("shell-quotes Matrix verification ids in follow-up command guidance", async () => {
    requestMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "self-verify-1",
        transactionId: "txn-'$(touch /tmp/pwn)",
      }),
    );
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "request", "--own-user"], {
      from: "user",
    });

    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Then run openclaw matrix verify start -- 'txn-'\\''$(touch /tmp/pwn)' to start SAS verification.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Run openclaw matrix verify sas -- 'txn-'\\''$(touch /tmp/pwn)' to display the SAS emoji or decimals.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- When the SAS matches, run openclaw matrix verify confirm-sas -- 'txn-'\\''$(touch /tmp/pwn)'.",
    );
  });

  it("shows Matrix SAS diagnostics and confirm/mismatch guidance", async () => {
    getMatrixVerificationSasMock.mockResolvedValue({
      decimal: [1234, 5678, 9012],
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "sas", "self-1"], { from: "user" });

    expect(getMatrixVerificationSasMock).toHaveBeenCalledWith("self-1", {
      accountId: "default",
      cfg: {},
    });
    expect(consoleLogMock).toHaveBeenCalledWith("SAS decimals: 1234 5678 9012");
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- If they match, run openclaw matrix verify confirm-sas -- self-1.",
    );
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- If they do not match, run openclaw matrix verify mismatch-sas -- self-1.",
    );
  });

  it("passes DM lookup details through Matrix verification follow-up commands", async () => {
    startMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "dm-verify-1",
        transactionId: "txn-dm",
        roomId: "!dm:example.org",
        otherUserId: "@alice:example.org",
      }),
    );
    const program = buildProgram();

    await program.parseAsync(
      [
        "matrix",
        "verify",
        "start",
        "txn-dm",
        "--user-id",
        "@alice:example.org",
        "--room-id",
        "!dm:example.org",
        "--account",
        "ops",
      ],
      { from: "user" },
    );

    expect(startMatrixVerificationMock).toHaveBeenCalledWith("txn-dm", {
      accountId: "ops",
      cfg: {},
      method: "sas",
      verificationDmUserId: "@alice:example.org",
      verificationDmRoomId: "!dm:example.org",
    });
    expect(consoleLogMock).toHaveBeenCalledWith(
      "- If they match, run openclaw matrix verify confirm-sas --user-id @alice:example.org --room-id '!dm:example.org' --account ops -- txn-dm.",
    );
  });

  it("prints stable transaction ids in follow-up commands after accepting verification", async () => {
    acceptMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "verification-1",
        transactionId: "txn-stable",
      }),
    );
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "accept", "verification-1"], { from: "user" });

    expect(consoleLogMock).toHaveBeenCalledWith(
      "- Run openclaw matrix verify start -- txn-stable to start SAS verification.",
    );
  });

  it("confirms, rejects, accepts, starts, and cancels Matrix verification requests", async () => {
    acceptMatrixVerificationMock.mockResolvedValue(mockMatrixVerificationSummary({ id: "in-1" }));
    startMatrixVerificationMock.mockResolvedValue(mockMatrixVerificationSummary({ id: "in-1" }));
    confirmMatrixVerificationSasMock.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", completed: true, pending: false }),
    );
    mismatchMatrixVerificationSasMock.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", phaseName: "cancelled", pending: false }),
    );
    cancelMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({ id: "in-1", phaseName: "cancelled", pending: false }),
    );
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "accept", "in-1"], { from: "user" });
    await program.parseAsync(["matrix", "verify", "start", "in-1"], { from: "user" });
    await program.parseAsync(["matrix", "verify", "confirm-sas", "in-1"], { from: "user" });
    await program.parseAsync(["matrix", "verify", "mismatch-sas", "in-1"], { from: "user" });
    await program.parseAsync(
      ["matrix", "verify", "cancel", "in-1", "--reason", "changed my mind"],
      { from: "user" },
    );

    expect(acceptMatrixVerificationMock).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(startMatrixVerificationMock).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
      method: "sas",
    });
    expect(confirmMatrixVerificationSasMock).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(mismatchMatrixVerificationSasMock).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
    });
    expect(cancelMatrixVerificationMock).toHaveBeenCalledWith("in-1", {
      accountId: "default",
      cfg: {},
      reason: "changed my mind",
      code: undefined,
    });
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

    await program.parseAsync(["matrix", "verify", "bootstrap", "--json"], {
      from: "user",
    });

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

  it("reads backup restore recovery key from stdin", async () => {
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      backupVersion: "1",
      imported: 1,
      total: 1,
      loadedFromSecretStorage: false,
      backup: {
        serverVersion: "1",
        activeVersion: "1",
        trusted: true,
        matchesDecryptionKey: true,
        decryptionKeyCached: true,
      },
    });
    mockRecoveryKeyStdin("stdin-recovery-key\n");
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "restore", "--recovery-key-stdin"], {
      from: "user",
    });

    expect(restoreMatrixRoomKeyBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryKey: "stdin-recovery-key",
      }),
    );
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

  it("passes loaded cfg to verify status action", async () => {
    const fakeCfg = { channels: { matrix: {} } };
    matrixRuntimeLoadConfigMock.mockReturnValue(fakeCfg);
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: null });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(getMatrixVerificationStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fakeCfg }),
    );
    expect(getMatrixVerificationStatusMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("readiness");
  });

  it("allows verify status to use degraded local-state diagnostics", async () => {
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: null });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status", "--allow-degraded-local-state"], {
      from: "user",
    });

    expect(getMatrixVerificationStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ readiness: "none" }),
    );
  });

  it("passes loaded cfg to all verify subcommands", async () => {
    const fakeCfg = { channels: { matrix: {} } };
    matrixRuntimeLoadConfigMock.mockReturnValue(fakeCfg);

    // verify bootstrap
    const program1 = buildProgram();
    await program1.parseAsync(["matrix", "verify", "bootstrap"], {
      from: "user",
    });
    expect(bootstrapMatrixVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fakeCfg }),
    );

    // verify device
    verifyMatrixRecoveryKeyMock.mockResolvedValue({ success: true });
    const program2 = buildProgram();
    await program2.parseAsync(["matrix", "verify", "device", "test-key"], {
      from: "user",
    });
    expect(verifyMatrixRecoveryKeyMock).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({ cfg: fakeCfg }),
    );

    // verify backup status
    getMatrixRoomKeyBackupStatusMock.mockResolvedValue({});
    const program3 = buildProgram();
    await program3.parseAsync(["matrix", "verify", "backup", "status"], {
      from: "user",
    });
    expect(getMatrixRoomKeyBackupStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fakeCfg }),
    );

    // verify backup reset
    const program4 = buildProgram();
    await program4.parseAsync(["matrix", "verify", "backup", "reset", "--yes"], { from: "user" });
    expect(resetMatrixRoomKeyBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fakeCfg }),
    );

    // verify backup restore
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      imported: 0,
      total: 0,
      backup: {},
    });
    const program5 = buildProgram();
    await program5.parseAsync(["matrix", "verify", "backup", "restore"], {
      from: "user",
    });
    expect(restoreMatrixRoomKeyBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: fakeCfg }),
    );
  });

  it("lists matrix devices", async () => {
    listMatrixOwnDevicesMock.mockResolvedValue([
      {
        deviceId: "A7hWr\u001B[31mQ70ea",
        displayName: "OpenClaw\u001B[2J Gateway",
        lastSeenIp: "127.0.0.1\u009B2J",
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

    expect(listMatrixOwnDevicesMock).toHaveBeenCalledWith({ accountId: "poe", cfg: {} });
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

    expect(pruneMatrixStaleGatewayDevicesMock).toHaveBeenCalledWith({
      accountId: "poe",
      cfg: {},
    });
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
    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
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
      afterWrite: { mode: "auto" },
    });
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops");
    expect(console.log).toHaveBeenCalledWith(
      "Bind this account to an agent: openclaw agents bind --agent <id> --bind matrix:ops",
    );
  });

  it("enables E2EE and bootstraps verification from matrix account add", async () => {
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
    resolveMatrixAccountConfigMock.mockImplementation(
      ({ cfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
        cfg.channels?.matrix?.accounts?.[accountId] ?? {},
    );
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
        "--access-token",
        "token",
        "--enable-e2ee",
      ],
      { from: "user" },
    );

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        channels: {
          matrix: {
            enabled: true,
            accounts: {
              ops: expect.objectContaining({
                encryption: true,
              }),
            },
          },
        },
      }),
      afterWrite: { mode: "auto" },
    });
    expect(bootstrapMatrixVerificationMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.objectContaining({
        channels: {
          matrix: expect.objectContaining({
            accounts: expect.objectContaining({
              ops: expect.objectContaining({
                encryption: true,
              }),
            }),
          }),
        },
      }),
    });
    expect(console.log).toHaveBeenCalledWith("Encryption: enabled");
    expect(console.log).toHaveBeenCalledWith("Matrix verification bootstrap: complete");
  });

  it("enables E2EE and prints verification status from matrix encryption setup", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://matrix.example.org",
              accessToken: "token",
            },
          },
        },
      },
    } as CoreConfig;
    matrixRuntimeLoadConfigMock.mockReturnValue(cfg);
    resolveMatrixAccountMock.mockReturnValue({
      configured: true,
      enabled: true,
      config: cfg.channels?.matrix?.accounts?.ops,
    });
    resolveMatrixAccountConfigMock.mockReturnValue({
      encryption: false,
    });
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
    mockMatrixVerificationStatus({
      recoveryKeyCreatedAt: "2026-03-09T06:00:00.000Z",
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "encryption", "setup", "--account", "ops"], {
      from: "user",
    });

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        channels: {
          matrix: {
            enabled: true,
            accounts: {
              ops: expect.objectContaining({
                encryption: true,
              }),
            },
          },
        },
      }),
      afterWrite: { mode: "auto" },
    });
    expect(bootstrapMatrixVerificationMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          matrix: expect.objectContaining({
            accounts: expect.objectContaining({
              ops: expect.objectContaining({ encryption: true }),
            }),
          }),
        }),
      }),
      recoveryKey: undefined,
      forceResetCrossSigning: false,
    });
    expect(getMatrixVerificationStatusMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.any(Object),
    });
    expect(console.log).toHaveBeenCalledWith("Account: ops");
    expect(console.log).toHaveBeenCalledWith(
      "Encryption config: enabled at channels.matrix.accounts.ops",
    );
    expect(console.log).toHaveBeenCalledWith("Bootstrap success: yes");
    expect(console.log).toHaveBeenCalledWith("Verified by owner: yes");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
  });

  it("skips encryption bootstrap when an encrypted account is already healthy", async () => {
    const cfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              encryption: true,
              homeserver: "https://matrix.example.org",
              accessToken: "token",
            },
          },
        },
      },
    } as CoreConfig;
    matrixRuntimeLoadConfigMock.mockReturnValue(cfg);
    resolveMatrixAccountMock.mockReturnValue({
      configured: true,
      enabled: true,
      config: cfg.channels?.matrix?.accounts?.ops,
    });
    resolveMatrixAccountConfigMock.mockReturnValue({
      encryption: true,
    });
    mockMatrixVerificationStatus({
      recoveryKeyCreatedAt: "2026-03-09T06:00:00.000Z",
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "encryption", "setup", "--account", "ops", "--json"], {
      from: "user",
    });

    expect(bootstrapMatrixVerificationMock).not.toHaveBeenCalled();
    expect(getMatrixVerificationStatusMock).toHaveBeenCalledTimes(1);
    expect(getMatrixVerificationStatusMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.any(Object),
      readiness: "none",
    });
    const jsonOutput = stdoutWriteMock.mock.calls.at(-1)?.[0];
    expect(typeof jsonOutput).toBe("string");
    expect(JSON.parse(String(jsonOutput))).toEqual(
      expect.objectContaining({
        accountId: "ops",
        encryptionChanged: false,
        bootstrap: expect.objectContaining({
          success: true,
          cryptoBootstrap: null,
        }),
        status: expect.objectContaining({
          verified: true,
        }),
      }),
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

    expect(bootstrapMatrixVerificationMock).toHaveBeenCalledWith({
      accountId: "ops",
      cfg: expect.any(Object),
    });
    expect(console.log).toHaveBeenCalledWith("Matrix verification bootstrap: complete");
    expect(console.log).toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp("2026-03-09T06:00:00.000Z")}`,
    );
    expect(console.log).toHaveBeenCalledWith("Backup version: 7");
    expect(console.log).toHaveBeenCalledWith(
      "Matrix device hygiene warning: stale OpenClaw devices detected (BritdXC6iL). Run openclaw matrix devices prune-stale --account ops.",
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

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
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

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const jsonOutput = stdoutWriteMock.mock.calls.at(-1)?.[0];
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
        cfg: expect.any(Object),
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
        cfg: expect.objectContaining({
          channels: expect.objectContaining({
            matrix: expect.objectContaining({
              accounts: expect.objectContaining({
                "ops-bot": expect.objectContaining({
                  homeserver: "https://matrix.example.org",
                }),
              }),
            }),
          }),
        }),
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
    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
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
    expect(stdoutWriteMock).toHaveBeenCalledWith(
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

    await program.parseAsync(["matrix", "verify", "bootstrap", "--json"], {
      from: "user",
    });

    expect(process.exitCode).toBe(0);
  });

  it("prints local timezone timestamps for verify status output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: recoveryCreatedAt });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status", "--verbose"], {
      from: "user",
    });

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
      "- Backup key is not loaded on this device. Run openclaw matrix verify backup restore to load it and restore old room keys. If restore still cannot load the key, run the shown printf pipeline with the Matrix recovery key env var for this account: printf '%s\\n' \"$MATRIX_RECOVERY_KEY\" | openclaw matrix verify backup restore --recovery-key-stdin.",
    );
    expect(console.log).not.toHaveBeenCalledWith(
      "- Backup is present but not trusted for this device. Re-run 'openclaw matrix verify device <key>'.",
    );
  });

  it("fails status with re-login guidance when the current Matrix device is missing on the server", async () => {
    getMatrixVerificationStatusMock.mockResolvedValue({
      encryptionEnabled: true,
      verified: false,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: false,
      userId: "@bot:example.org",
      deviceId: "DEVICE123",
      serverDeviceKnown: false,
      backupVersion: null,
      backup: {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: true,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
      recoveryKeyStored: true,
      recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      pendingVerifications: 0,
    });
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "status"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      "Device issue: current Matrix device is missing from the homeserver device list",
    );
    expect(console.log).toHaveBeenCalledWith(
      "- This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with openclaw matrix account add --homeserver '<url>' --user-id '<@user:server>' --password '<password>' --device-name OpenClaw-Gateway. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run openclaw matrix account add --homeserver '<url>' --access-token '<token>'.",
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
      "- If you want a fresh backup baseline and accept losing unrecoverable history, run openclaw matrix verify backup reset --yes. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.",
    );
  });

  it("requires --yes before resetting the Matrix room-key backup", async () => {
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "reset"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(resetMatrixRoomKeyBackupMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Backup reset failed: Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run openclaw matrix verify backup reset --yes.",
    );
  });

  it("resets the Matrix room-key backup when confirmed", async () => {
    const program = buildProgram();

    await program.parseAsync(["matrix", "verify", "backup", "reset", "--yes"], {
      from: "user",
    });

    expect(resetMatrixRoomKeyBackupMock).toHaveBeenCalledWith({
      accountId: "default",
      cfg: {},
      rotateRecoveryKey: false,
    });
    expect(console.log).toHaveBeenCalledWith("Reset success: yes");
    expect(console.log).toHaveBeenCalledWith("Previous backup version: 1");
    expect(console.log).toHaveBeenCalledWith("Deleted backup version: 1");
    expect(console.log).toHaveBeenCalledWith("Current backup version: 2");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
  });

  it("passes recovery-key rotation through backup reset", async () => {
    const program = buildProgram();

    await program.parseAsync(
      ["matrix", "verify", "backup", "reset", "--yes", "--rotate-recovery-key"],
      {
        from: "user",
      },
    );

    expect(resetMatrixRoomKeyBackupMock).toHaveBeenCalledWith({
      accountId: "default",
      cfg: {},
      rotateRecoveryKey: true,
    });
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
      cfg: {},
      includeRecoveryKey: false,
    });
    expect(console.log).toHaveBeenCalledWith("Account: assistant");
    expect(console.log).toHaveBeenCalledWith(
      "- Run the shown printf pipeline with the Matrix recovery key env var for this account: printf '%s\\n' \"$MATRIX_RECOVERY_KEY_ASSISTANT\" | openclaw matrix verify device --recovery-key-stdin --account assistant. If you do not have the recovery key but still have another verified Matrix client, run openclaw matrix verify self --account assistant instead.",
    );
    expect(console.log).toHaveBeenCalledWith(
      "- Run openclaw matrix verify bootstrap --account assistant to create a room key backup.",
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
