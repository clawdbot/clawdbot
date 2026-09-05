// Matrix tests cover cli plugin behavior.
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { formatZonedTimestamp } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMatrixCli } from "./cli.js";
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
const matrixRuntimeMutateConfigFileMock = vi.fn();
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

function mockRecoveryKeyStdin(...values: string[]): void {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockReturnValue(
    (async function* (): AsyncGenerator<Buffer, undefined, unknown> {
      for (const value of values) {
        yield Buffer.from(value);
      }
      return undefined;
    })(),
  );
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const resolvedIndex = callIndex < 0 ? mock.mock.calls.length + callIndex : callIndex;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function stdoutWriteArg(callIndex = -1) {
  return mockCallArg(stdoutWriteMock, callIndex);
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
      mutateConfigFile: (...args: unknown[]) => matrixRuntimeMutateConfigFileMock(...args),
      replaceConfigFile: (...args: unknown[]) => matrixRuntimeReplaceConfigFileMock(...args),
    },
  }),
}));

function buildProgram(): Command {
  const program = new Command();
  registerMatrixCli({ program });
  return program;
}

async function runMatrixCli(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync(argv, { from: "user" });
}

function matrixAccountPasswordArgs(accountId = "ops", ...extra: string[]): string[] {
  return [
    "matrix",
    "account",
    "add",
    "--account",
    accountId,
    "--homeserver",
    "https://matrix.example.org",
    "--user-id",
    "@ops:example.org",
    "--password",
    "secret",
    ...extra,
  ];
}

function mockMatrixAccountConfigApply(): void {
  matrixSetupApplyAccountConfigMock.mockImplementation(
    ({ cfg, accountId }: { cfg: Record<string, unknown>; accountId: string }) => ({
      ...cfg,
      channels: {
        ...(cfg.channels as Record<string, unknown> | undefined),
        matrix: { accounts: { [accountId]: { homeserver: "https://matrix.example.org" } } },
      },
    }),
  );
}

function healthyMatrixBackup(overrides: Record<string, unknown> = {}) {
  return {
    serverVersion: "1",
    activeVersion: "1",
    trusted: true,
    matchesDecryptionKey: true,
    decryptionKeyCached: true,
    ...overrides,
  };
}

function diagnosticMatrixBackup(overrides: Record<string, unknown> = {}) {
  return {
    ...healthyMatrixBackup(),
    keyLoadAttempted: false,
    keyLoadError: null,
    ...overrides,
  };
}

function matrixVerificationState(overrides: Record<string, unknown> = {}) {
  const { backup: backupOverrides, ...statusOverrides } = overrides;
  return {
    encryptionEnabled: true,
    verified: true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    userId: "@bot:example.org",
    deviceId: "DEVICE123",
    backupVersion: "1",
    backup: healthyMatrixBackup(backupOverrides as Record<string, unknown> | undefined),
    recoveryKeyStored: true,
    recoveryKeyCreatedAt: null,
    ...statusOverrides,
  };
}

function matrixVerificationStatus(overrides: Record<string, unknown> = {}) {
  return { ...matrixVerificationState(overrides), pendingVerifications: 0 };
}

function successfulMatrixBootstrap(
  recoveryKeyCreatedAt: string | null = null,
  backupVersion: string | null = null,
) {
  return {
    success: true,
    verification: { recoveryKeyCreatedAt, backupVersion },
    crossSigning: {},
    pendingVerifications: 0,
    cryptoBootstrap: {},
  };
}

function formatExpectedLocalTimestamp(value: string): string {
  return formatZonedTimestamp(new Date(value), { displaySeconds: true }) ?? value;
}

function mockMatrixVerificationStatus(params: {
  recoveryKeyCreatedAt: string | null;
  verifiedAt?: string;
}) {
  getMatrixVerificationStatusMock.mockResolvedValue(
    matrixVerificationStatus({
      recoveryKeyCreatedAt: params.recoveryKeyCreatedAt,
      serverDeviceKnown: true,
      verifiedAt: params.verifiedAt,
    }),
  );
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
    matrixRuntimeMutateConfigFileMock.mockImplementation(async ({ mutate, afterWrite }) => {
      const draft = structuredClone(matrixRuntimeLoadConfigMock());
      await mutate(draft, { snapshot: { runtimeConfig: structuredClone(draft) } });
      await matrixRuntimeReplaceConfigFileMock({ nextConfig: draft, afterWrite });
    });
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
    bootstrapMatrixVerificationMock.mockResolvedValue(successfulMatrixBootstrap());
    resetMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      previousVersion: "1",
      deletedVersion: "1",
      createdVersion: "2",
      backup: diagnosticMatrixBackup({ serverVersion: "2", activeVersion: "2" }),
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
    await runMatrixCli(["matrix", "verify", "device", "bad-key", "--json"]);

    expect(process.exitCode).toBe(1);
  });

  it("prints recovery-key and identity-trust diagnostics for device verification failures", async () => {
    verifyMatrixRecoveryKeyMock.mockResolvedValue({
      ...matrixVerificationState({
        verified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        backupVersion: "7",
        backup: diagnosticMatrixBackup({
          serverVersion: "7",
          activeVersion: "7",
          keyLoadAttempted: true,
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      }),
      success: false,
      error:
        "Matrix recovery key was applied, but this device still lacks full Matrix identity trust.",
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: false,
    });
    await runMatrixCli(["matrix", "verify", "device", "valid-key"]);

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
          backup: diagnosticMatrixBackup(),
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
    await runMatrixCli(["matrix", "verify", "self", "--account", "ops", "--timeout-ms", "5000"]);

    const selfVerifyArg = mockCallArg(runMatrixSelfVerificationMock) as Record<string, unknown>;
    expectRecordFields(selfVerifyArg, {
      accountId: "ops",
      cfg: {},
      timeoutMs: 5000,
    });
    expect(selfVerifyArg.onRequested).toBeTypeOf("function");
    expect(selfVerifyArg.onReady).toBeTypeOf("function");
    expect(selfVerifyArg.onSas).toBeTypeOf("function");
    expect(selfVerifyArg.confirmSas).toBeTypeOf("function");
    expect(consoleLogMock).toHaveBeenCalledWith("Self-verification complete.");
    expect(consoleLogMock).toHaveBeenCalledWith("Device verified by owner: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Cross-signing verified: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Signed by owner: yes");
    expect(consoleLogMock).toHaveBeenCalledWith("Backup: active and trusted on this device");
  });

  it("rejects malformed Matrix self-verification timeout values", async () => {
    await runMatrixCli(["matrix", "verify", "self", "--timeout-ms", "5000ms"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Self-verification failed: --timeout-ms must be an integer",
    );
    expect(runMatrixSelfVerificationMock).not.toHaveBeenCalled();
  });

  it("rejects non-positive Matrix self-verification timeout values", async () => {
    await runMatrixCli(["matrix", "verify", "self", "--timeout-ms", "-1"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Self-verification failed: --timeout-ms must be a positive integer",
    );
    expect(runMatrixSelfVerificationMock).not.toHaveBeenCalled();
  });

  it("requests Matrix self-verification and prints the follow-up SAS commands", async () => {
    requestMatrixVerificationMock.mockResolvedValue(
      mockMatrixVerificationSummary({
        id: "self-verify-1",
        hasSas: false,
        sas: undefined,
      }),
    );
    await runMatrixCli(["matrix", "verify", "request", "--own-user", "--account", "ops"]);

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
    await runMatrixCli([
      "matrix",
      "verify",
      "request",
      "--user-id",
      "@alice:example.org",
      "--room-id",
      "!room-'$(x):example.org",
    ]);

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
    await runMatrixCli(["matrix", "verify", "request", "--own-user", "--account", "ops"]);

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
    await runMatrixCli([
      "matrix",
      "verify",
      "request",
      "--own-user",
      "--user-id",
      "@other:example.org",
    ]);

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
    await runMatrixCli(["matrix", "verify", "list"]);

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
    await runMatrixCli(["matrix", "verify", "list"]);

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
    getMatrixVerificationStatusMock.mockResolvedValue(
      matrixVerificationStatus({
        verified: false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        userId: "@bot\u001B[2J:example.org",
        deviceId: "PHONE\r\u009B2J123",
        backupVersion: "1\u001B[31m",
        backup: diagnosticMatrixBackup({
          serverVersion: "2\u001B[31m",
          activeVersion: "1\u009B2J",
          trusted: false,
          matchesDecryptionKey: false,
          decryptionKeyCached: false,
          keyLoadAttempted: true,
          keyLoadError: "Remote\n\u009B31mforged",
        }),
        recoveryKeyStored: false,
      }),
    );
    await runMatrixCli(["matrix", "verify", "status", "--verbose"]);

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
    await runMatrixCli(["matrix", "verify", "request", "--own-user"]);

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
    await runMatrixCli(["matrix", "verify", "sas", "self-1"]);

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
    await runMatrixCli([
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
    ]);

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
    await runMatrixCli(["matrix", "verify", "accept", "verification-1"]);

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
    await runMatrixCli(["matrix", "verify", "accept", "in-1"]);
    await runMatrixCli(["matrix", "verify", "start", "in-1"]);
    await runMatrixCli(["matrix", "verify", "confirm-sas", "in-1"]);
    await runMatrixCli(["matrix", "verify", "mismatch-sas", "in-1"]);
    await runMatrixCli(["matrix", "verify", "cancel", "in-1", "--reason", "changed my mind"]);

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
    await runMatrixCli(["matrix", "verify", "bootstrap", "--json"]);

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
      backup: healthyMatrixBackup({
        activeVersion: null,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
      }),
    });
    await runMatrixCli(["matrix", "verify", "backup", "restore", "--json"]);

    expect(process.exitCode).toBe(1);
  });

  it("reads backup restore recovery key from stdin", async () => {
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      backupVersion: "1",
      imported: 1,
      total: 1,
      loadedFromSecretStorage: false,
      backup: healthyMatrixBackup(),
    });
    mockRecoveryKeyStdin("stdin-recovery-key\n");
    await runMatrixCli(["matrix", "verify", "backup", "restore", "--recovery-key-stdin"]);

    expectRecordFields(mockCallArg(restoreMatrixRoomKeyBackupMock), {
      recoveryKey: "stdin-recovery-key",
    });
  });

  it("rejects oversized recovery key stdin before backup restore", async () => {
    mockRecoveryKeyStdin("x".repeat(1024 * 1024), "x");
    await runMatrixCli(["matrix", "verify", "backup", "restore", "--recovery-key-stdin"]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Backup restore failed: Matrix recovery key stdin exceeds 1048576 bytes.",
    );
    expect(restoreMatrixRoomKeyBackupMock).not.toHaveBeenCalled();
  });

  it("preserves a multibyte recovery key at the stdin byte limit", async () => {
    const recoveryKey = "é".repeat((1024 * 1024) / 2);
    mockRecoveryKeyStdin(recoveryKey);
    await runMatrixCli(["matrix", "verify", "backup", "restore", "--recovery-key-stdin"]);

    expectRecordFields(mockCallArg(restoreMatrixRoomKeyBackupMock), { recoveryKey });
  });

  it("sets non-zero exit code for backup reset failures in JSON mode", async () => {
    resetMatrixRoomKeyBackupMock.mockResolvedValue({
      success: false,
      error: "reset failed",
      previousVersion: "1",
      deletedVersion: "1",
      createdVersion: null,
      backup: diagnosticMatrixBackup({
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: null,
      }),
    });
    await runMatrixCli(["matrix", "verify", "backup", "reset", "--yes", "--json"]);

    expect(process.exitCode).toBe(1);
  });

  it("passes loaded cfg to verify status action", async () => {
    const fakeCfg = { channels: { matrix: {} } };
    matrixRuntimeLoadConfigMock.mockReturnValue(fakeCfg);
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: null });
    await runMatrixCli(["matrix", "verify", "status"]);

    const statusArg = mockCallArg(getMatrixVerificationStatusMock, -1);
    expectRecordFields(statusArg, { cfg: fakeCfg });
    expect(statusArg).not.toHaveProperty("readiness");
  });

  it("allows verify status to use degraded local-state diagnostics", async () => {
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: null });
    await runMatrixCli(["matrix", "verify", "status", "--allow-degraded-local-state"]);

    expectRecordFields(mockCallArg(getMatrixVerificationStatusMock), { readiness: "none" });
  });

  describe.each([false, true])("recovery key output (verbose=%s)", (verbose) => {
    it.each([
      { include: false, recoveryKey: undefined },
      { include: true, recoveryKey: null },
      { include: true, recoveryKey: "test-recovery-key" },
    ])(
      "prints a safe hint for include=$include, key=$recoveryKey",
      async ({ include, recoveryKey }) => {
        getMatrixVerificationStatusMock.mockResolvedValue(
          matrixVerificationStatus({ recoveryKey, recoveryKeyStored: recoveryKey !== null }),
        );
        await runMatrixCli([
          "matrix",
          "verify",
          "status",
          ...(include ? ["--include-recovery-key"] : []),
          ...(verbose ? ["--verbose"] : []),
        ]);

        expectRecordFields(mockCallArg(getMatrixVerificationStatusMock), {
          includeRecoveryKey: include,
        });
        const output = consoleLogMock.mock.calls.flat().join("\n");
        expect(
          output.includes(
            "Recovery key: available (re-run with --json to include the raw key value in output)",
          ),
        ).toBe(Boolean(recoveryKey));
        expect(output).toContain(`Recovery key stored: ${recoveryKey === null ? "no" : "yes"}`);
        expect(output).not.toContain("test-recovery-key");
        expect(stdoutWriteMock).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      },
    );

    it.each([false, true])("preserves JSON recovery key opt-in=%s", async (include) => {
      const status = matrixVerificationStatus(include ? { recoveryKey: "test-recovery-key" } : {});
      getMatrixVerificationStatusMock.mockResolvedValue(status);
      await runMatrixCli([
        "matrix",
        "verify",
        "status",
        "--json",
        ...(include ? ["--include-recovery-key"] : []),
        ...(verbose ? ["--verbose"] : []),
      ]);

      expectRecordFields(mockCallArg(getMatrixVerificationStatusMock), {
        includeRecoveryKey: include,
      });
      expect(JSON.parse(String(stdoutWriteArg()))).toEqual(status);
      expect(consoleLogMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  it("passes loaded cfg to all verify subcommands", async () => {
    const fakeCfg = { channels: { matrix: {} } };
    matrixRuntimeLoadConfigMock.mockReturnValue(fakeCfg);

    // verify bootstrap
    await runMatrixCli(["matrix", "verify", "bootstrap"]);
    expectRecordFields(mockCallArg(bootstrapMatrixVerificationMock), { cfg: fakeCfg });

    // verify device
    verifyMatrixRecoveryKeyMock.mockResolvedValue({ success: true });
    await runMatrixCli(["matrix", "verify", "device", "test-key"]);
    expect(mockCallArg(verifyMatrixRecoveryKeyMock)).toBe("test-key");
    expectRecordFields(mockCallArg(verifyMatrixRecoveryKeyMock, 0, 1), { cfg: fakeCfg });

    // verify backup status
    getMatrixRoomKeyBackupStatusMock.mockResolvedValue({});
    await runMatrixCli(["matrix", "verify", "backup", "status"]);
    expectRecordFields(mockCallArg(getMatrixRoomKeyBackupStatusMock), { cfg: fakeCfg });

    // verify backup reset
    await runMatrixCli(["matrix", "verify", "backup", "reset", "--yes"]);
    expectRecordFields(mockCallArg(resetMatrixRoomKeyBackupMock), { cfg: fakeCfg });

    // verify backup restore
    restoreMatrixRoomKeyBackupMock.mockResolvedValue({
      success: true,
      imported: 0,
      total: 0,
      backup: {},
    });
    await runMatrixCli(["matrix", "verify", "backup", "restore"]);
    expectRecordFields(mockCallArg(restoreMatrixRoomKeyBackupMock), { cfg: fakeCfg });
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
    await runMatrixCli(["matrix", "devices", "list", "--account", "poe"]);

    expect(listMatrixOwnDevicesMock).toHaveBeenCalledWith({ accountId: "poe", cfg: {} });
    expect(console.log).toHaveBeenCalledWith("Account: poe");
    expect(console.log).toHaveBeenCalledWith("- A7hWrQ70ea (current, OpenClaw Gateway)");
    expect(console.log).toHaveBeenCalledWith("  Last IP: 127.0.0.1");
    expect(console.log).toHaveBeenCalledWith("- BritdXC6iL (OpenClaw Gateway)");
  });

  it("omits invalid matrix device last seen timestamps", async () => {
    listMatrixOwnDevicesMock.mockResolvedValue([
      {
        deviceId: "DEVICE123",
        displayName: "OpenClaw Gateway",
        lastSeenIp: "127.0.0.1",
        lastSeenTs: 8_700_000_000_000_000,
        current: true,
      },
    ]);
    await runMatrixCli(["matrix", "devices", "list", "--account", "poe"]);

    expect(console.log).toHaveBeenCalledWith("Account: poe");
    expect(console.log).toHaveBeenCalledWith("- DEVICE123 (current, OpenClaw Gateway)");
    expect(console.log).toHaveBeenCalledWith("  Last IP: 127.0.0.1");
    expect(
      consoleLogMock.mock.calls.some(([message]) => String(message).startsWith("  Last seen:")),
    ).toBe(false);
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
    await runMatrixCli(["matrix", "devices", "prune-stale", "--account", "poe"]);

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
    mockMatrixAccountConfigApply();
    await runMatrixCli(matrixAccountPasswordArgs("Ops"));

    const validateArg = mockCallArg(matrixSetupValidateInputMock) as Record<string, unknown>;
    expect(validateArg.accountId).toBe("ops");
    expectRecordFields(validateArg.input, {
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      password: "secret", // pragma: allowlist secret
    });
    const replaceArg = mockCallArg(matrixRuntimeReplaceConfigFileMock) as {
      nextConfig?: CoreConfig;
      afterWrite?: unknown;
    };
    expect(replaceArg.nextConfig?.channels?.matrix?.accounts?.ops?.homeserver).toBe(
      "https://matrix.example.org",
    );
    expect(replaceArg.afterWrite).toEqual({ mode: "auto" });
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops");
    expect(console.log).toHaveBeenCalledWith(
      "Bind this account to an agent: openclaw agents bind --agent <id> --bind matrix:ops",
    );
  });

  it("rejects negative Matrix initial sync limits at the CLI boundary", async () => {
    await runMatrixCli([
      "matrix",
      "account",
      "add",
      "--homeserver",
      "https://matrix.example.org",
      "--user-id",
      "@ops:example.org",
      "--password",
      "secret",
      "--initial-sync-limit",
      "-1",
    ]);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(
      "Account setup failed: --initial-sync-limit must be a non-negative integer",
    );
    expect(matrixSetupValidateInputMock).not.toHaveBeenCalled();
    expect(matrixRuntimeReplaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("enables E2EE and bootstraps verification from matrix account add", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    mockMatrixAccountConfigApply();
    resolveMatrixAccountConfigMock.mockImplementation(
      ({ cfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
        cfg.channels?.matrix?.accounts?.[accountId] ?? {},
    );
    bootstrapMatrixVerificationMock.mockResolvedValue(
      successfulMatrixBootstrap("2026-03-09T06:00:00.000Z", "7"),
    );
    await runMatrixCli([
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
    ]);

    const replaceArg = mockCallArg(matrixRuntimeReplaceConfigFileMock) as {
      nextConfig?: CoreConfig;
      afterWrite?: unknown;
    };
    expect(replaceArg.nextConfig?.channels?.matrix?.enabled).toBe(true);
    expect(replaceArg.nextConfig?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
    expect(replaceArg.afterWrite).toEqual({ mode: "auto" });
    const bootstrapArg = mockCallArg(bootstrapMatrixVerificationMock) as {
      accountId?: string;
      cfg?: CoreConfig;
    };
    expect(bootstrapArg.accountId).toBe("ops");
    expect(bootstrapArg.cfg?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
    expect(console.log).toHaveBeenCalledWith("Encryption: enabled");
    expect(console.log).toHaveBeenCalledWith("Matrix verification bootstrap: complete");
  });

  it("reads the recovery key from stdin during matrix encryption setup", async () => {
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
    bootstrapMatrixVerificationMock.mockResolvedValue(
      successfulMatrixBootstrap("2026-03-09T06:00:00.000Z", "7"),
    );
    mockMatrixVerificationStatus({
      recoveryKeyCreatedAt: "2026-03-09T06:00:00.000Z",
    });
    mockRecoveryKeyStdin("stdin-recovery-key\n");
    await runMatrixCli([
      "matrix",
      "encryption",
      "setup",
      "--account",
      "ops",
      "--recovery-key-stdin",
    ]);

    const replaceArg = mockCallArg(matrixRuntimeReplaceConfigFileMock) as {
      nextConfig?: CoreConfig;
      afterWrite?: unknown;
    };
    expect(replaceArg.nextConfig?.channels?.matrix?.enabled).toBe(true);
    expect(replaceArg.nextConfig?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
    expect(replaceArg.afterWrite).toEqual({ mode: "auto" });
    const bootstrapArg = mockCallArg(bootstrapMatrixVerificationMock) as {
      accountId?: string;
      cfg?: CoreConfig;
      recoveryKey?: unknown;
      forceResetCrossSigning?: boolean;
    };
    expect(bootstrapArg.accountId).toBe("ops");
    expect(bootstrapArg.cfg?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
    expect(bootstrapArg.recoveryKey).toBe("stdin-recovery-key");
    expect(bootstrapArg.forceResetCrossSigning).toBe(false);
    const statusArg = mockCallArg(getMatrixVerificationStatusMock) as Record<string, unknown>;
    expect(statusArg.accountId).toBe("ops");
    expect(statusArg.cfg).toBeTypeOf("object");
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
    await runMatrixCli(["matrix", "encryption", "setup", "--account", "ops", "--json"]);

    expect(bootstrapMatrixVerificationMock).not.toHaveBeenCalled();
    expect(getMatrixVerificationStatusMock).toHaveBeenCalledTimes(1);
    const statusArg = mockCallArg(getMatrixVerificationStatusMock) as Record<string, unknown>;
    expectRecordFields(statusArg, { accountId: "ops", readiness: "none" });
    expect(statusArg.cfg).toBeTypeOf("object");
    const jsonOutput = stdoutWriteArg();
    expect(typeof jsonOutput).toBe("string");
    const payload = JSON.parse(String(jsonOutput)) as Record<string, unknown>;
    expectRecordFields(payload, { accountId: "ops", encryptionChanged: false });
    expectRecordFields(payload.bootstrap, { success: true, cryptoBootstrap: null });
    expectRecordFields(payload.status, { verified: true });
  });

  it.each(["encryption setup", "account add"])(
    "keeps %s private until its crypto clients have retired",
    async (command) => {
      const cfg: CoreConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: { homeserver: "https://matrix.example.org", accessToken: "token" },
            },
          },
        },
      };
      matrixRuntimeLoadConfigMock.mockReturnValue(cfg);
      resolveMatrixAccountMock.mockReturnValue({ configured: true });
      resolveMatrixAccountConfigMock.mockImplementation(
        ({ cfg: inputCfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
          inputCfg.channels?.matrix?.accounts?.[accountId] ?? {},
      );
      const bootstrapEntered = createDeferred<void>();
      const bootstrapRetired = createDeferred<void>();
      const profileEntered = createDeferred<void>();
      const profileRetired = createDeferred<void>();
      const readEntered = createDeferred<void>();
      const readRetired = createDeferred<void>();
      bootstrapMatrixVerificationMock.mockImplementationOnce(async () => {
        bootstrapEntered.resolve();
        await bootstrapRetired.promise;
        return successfulMatrixBootstrap();
      });
      if (command === "account add") {
        updateMatrixOwnProfileMock.mockImplementationOnce(async () => {
          profileEntered.resolve();
          await profileRetired.promise;
          return {
            displayNameUpdated: false,
            avatarUpdated: true,
            resolvedAvatarUrl: "mxc://example.org/avatar",
            convertedAvatarFromHttp: true,
          };
        });
      }
      const finalRead =
        command === "encryption setup" ? getMatrixVerificationStatusMock : listMatrixOwnDevicesMock;
      finalRead.mockImplementationOnce(async () => {
        readEntered.resolve();
        await readRetired.promise;
        return command === "encryption setup" ? matrixVerificationStatus() : [];
      });
      const gatewayActivations: CoreConfig[] = [];
      const latestCfg = structuredClone(cfg);
      latestCfg.messages = { ackReaction: "updated-during-bootstrap" };
      matrixRuntimeMutateConfigFileMock.mockImplementationOnce(async ({ mutate, afterWrite }) => {
        const draft = structuredClone(latestCfg);
        await mutate(draft, { snapshot: { runtimeConfig: latestCfg } });
        await matrixRuntimeReplaceConfigFileMock({ nextConfig: draft, afterWrite });
      });
      matrixRuntimeReplaceConfigFileMock.mockImplementationOnce(
        async ({ nextConfig }: { nextConfig: CoreConfig }) => {
          gatewayActivations.push(nextConfig);
        },
      );
      const running = runMatrixCli(
        command === "encryption setup"
          ? ["matrix", "encryption", "setup", "--account", "ops", "--json"]
          : matrixAccountPasswordArgs(
              "ops",
              "--enable-e2ee",
              "--avatar-url",
              "https://example.org/avatar.png",
              "--json",
            ),
      );
      try {
        await bootstrapEntered.promise;
        expect(gatewayActivations).toEqual([]);
        bootstrapRetired.resolve();
        if (command === "account add") {
          await profileEntered.promise;
          expect(gatewayActivations).toEqual([]);
          profileRetired.resolve();
        }
        await readEntered.promise;
        expect(gatewayActivations).toEqual([]);
      } finally {
        bootstrapRetired.resolve();
        profileRetired.resolve();
        readRetired.resolve();
        await running;
      }
      expect(gatewayActivations).toHaveLength(1);
      expect(gatewayActivations[0]?.channels?.matrix?.accounts?.ops?.encryption).toBe(true);
      expect(gatewayActivations[0]?.messages?.ackReaction).toBe("updated-during-bootstrap");
      if (command === "account add") {
        expect(gatewayActivations[0]?.channels?.matrix?.accounts?.ops?.avatarUrl).toBe(
          "mxc://example.org/avatar",
        );
      } else {
        expectRecordFields(JSON.parse(String(stdoutWriteArg())), {
          success: true,
          status: matrixVerificationStatus(),
        });
      }
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each(["bootstrap result", "bootstrap throw", "status throw"])(
    "still saves encryption setup after a %s failure",
    async (failure) => {
      matrixRuntimeLoadConfigMock.mockReturnValue({ channels: { matrix: {} } });
      resolveMatrixAccountMock.mockReturnValue({ configured: true });
      getMatrixVerificationStatusMock.mockResolvedValue(matrixVerificationStatus());
      if (failure === "bootstrap result") {
        bootstrapMatrixVerificationMock.mockResolvedValue({
          ...successfulMatrixBootstrap(),
          success: false,
          error: "bootstrap unavailable",
        });
      } else if (failure === "bootstrap throw") {
        bootstrapMatrixVerificationMock.mockRejectedValue(new Error("bootstrap unavailable"));
      } else {
        getMatrixVerificationStatusMock.mockRejectedValue(new Error("status unavailable"));
      }
      await runMatrixCli(["matrix", "encryption", "setup", "--json"]);

      expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalledOnce();
      const write = mockCallArg(matrixRuntimeReplaceConfigFileMock) as { nextConfig: CoreConfig };
      expect(write.nextConfig.channels?.matrix?.encryption).toBe(true);
      expect(process.exitCode).toBe(1);
      expectRecordFields(JSON.parse(String(stdoutWriteArg())), { success: false });
    },
  );

  it.each([
    ["encryption setup", "account replacement"],
    ["account add", "account replacement"],
    ["encryption setup", "channel disable"],
    ["account add", "channel disable"],
  ])("does not publish %s after concurrent %s", async (command, change) => {
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          enabled: true,
          accounts: {
            ops: {
              enabled: true,
              homeserver: "https://matrix.example.org",
              accessToken: "original-token",
            },
          },
        },
      },
    };
    matrixRuntimeLoadConfigMock.mockReturnValue(cfg);
    resolveMatrixAccountMock.mockReturnValue({ configured: true });
    resolveMatrixAccountConfigMock.mockImplementation(
      ({ cfg: inputCfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
        inputCfg.channels?.matrix?.accounts?.[accountId] ?? {},
    );
    getMatrixVerificationStatusMock.mockResolvedValue(matrixVerificationStatus());
    const replaced: CoreConfig =
      change === "channel disable"
        ? {
            ...cfg,
            channels: { matrix: { ...cfg.channels?.matrix, enabled: false } },
          }
        : {
            channels: {
              matrix: {
                accounts: {
                  ops: {
                    homeserver: "https://replacement.example.org",
                    accessToken: "replacement-token",
                  },
                },
              },
            },
          };
    matrixRuntimeMutateConfigFileMock.mockImplementationOnce(async ({ mutate, afterWrite }) => {
      const draft = structuredClone(replaced);
      await mutate(draft, { snapshot: { runtimeConfig: replaced } });
      await matrixRuntimeReplaceConfigFileMock({ nextConfig: draft, afterWrite });
    });
    await runMatrixCli(
      command === "encryption setup"
        ? ["matrix", "encryption", "setup", "--account", "ops", "--json"]
        : matrixAccountPasswordArgs("ops", "--enable-e2ee", "--json"),
    );

    expect(matrixRuntimeReplaceConfigFileMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stdoutWriteArg())).error).toContain("changed during setup");
    expect(JSON.parse(String(stdoutWriteArg())).error).toContain("run the setup command again");
  });

  it("compares runtime account config while preserving source SecretRefs", async () => {
    const cfg: CoreConfig = {
      channels: {
        matrix: { accessToken: "resolved-token", homeserver: "https://matrix.example.org" },
      },
    };
    const source: CoreConfig = {
      channels: {
        matrix: {
          accessToken: { source: "env", provider: "default", id: "MATRIX_ACCESS_TOKEN" },
          homeserver: "https://matrix.example.org",
        },
      },
    };
    matrixRuntimeLoadConfigMock.mockReturnValue(cfg);
    resolveMatrixAccountMock.mockReturnValue({ configured: true });
    getMatrixVerificationStatusMock.mockResolvedValue(matrixVerificationStatus());
    matrixRuntimeMutateConfigFileMock.mockImplementationOnce(async ({ mutate, afterWrite }) => {
      const draft = structuredClone(source);
      await mutate(draft, { snapshot: { runtimeConfig: cfg } });
      await matrixRuntimeReplaceConfigFileMock({ nextConfig: draft, afterWrite });
    });
    await runMatrixCli(["matrix", "encryption", "setup", "--json"]);

    expect(process.exitCode).toBeUndefined();
    const write = mockCallArg(matrixRuntimeReplaceConfigFileMock) as { nextConfig: CoreConfig };
    expect(write.nextConfig.channels?.matrix?.accessToken).toEqual(
      source.channels?.matrix?.accessToken,
    );
    expect(write.nextConfig.channels?.matrix?.encryption).toBe(true);
  });

  it.each(["bootstrap", "status"])(
    "reports publication failure ahead of an earlier %s failure",
    async (stage) => {
      resolveMatrixAccountMock.mockReturnValue({ configured: true });
      const action =
        stage === "bootstrap" ? bootstrapMatrixVerificationMock : getMatrixVerificationStatusMock;
      action.mockRejectedValueOnce(new Error(`${stage} failed`));
      matrixRuntimeReplaceConfigFileMock.mockRejectedValueOnce(
        new Error("config publication failed"),
      );
      await runMatrixCli(["matrix", "encryption", "setup", "--json"]);

      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(stdoutWriteArg()))).toEqual({
        success: false,
        error: "config publication failed",
      });
    },
  );

  it("saves an encrypted account and reports bootstrap, profile, and device-health failures", async () => {
    resolveMatrixAccountConfigMock.mockImplementation(
      ({ cfg, accountId }: { cfg: CoreConfig; accountId: string }) =>
        cfg.channels?.matrix?.accounts?.[accountId] ?? {},
    );
    bootstrapMatrixVerificationMock.mockRejectedValueOnce(new Error("bootstrap failed"));
    updateMatrixOwnProfileMock.mockRejectedValueOnce(new Error("profile failed"));
    listMatrixOwnDevicesMock.mockRejectedValueOnce(new Error("device health failed"));
    await runMatrixCli(
      matrixAccountPasswordArgs("ops", "--enable-e2ee", "--name", "Ops", "--json"),
    );

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
    const result = JSON.parse(String(stdoutWriteArg()));
    expect(result.encryptionEnabled).toBe(true);
    expectRecordFields(result.verificationBootstrap, {
      attempted: true,
      success: false,
      error: "bootstrap failed",
    });
    expectRecordFields(result.profile, { attempted: true, error: "profile failed" });
    expectRecordFields(result.deviceHealth, { error: "device health failed" });
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
    bootstrapMatrixVerificationMock.mockResolvedValue(
      successfulMatrixBootstrap("2026-03-09T06:00:00.000Z", "7"),
    );
    await runMatrixCli(matrixAccountPasswordArgs());

    const bootstrapArg = mockCallArg(bootstrapMatrixVerificationMock) as Record<string, unknown>;
    expect(bootstrapArg.accountId).toBe("ops");
    expect(bootstrapArg.cfg).toBeTypeOf("object");
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
    await runMatrixCli(matrixAccountPasswordArgs());

    expect(bootstrapMatrixVerificationMock).not.toHaveBeenCalled();
  });

  it("warns instead of failing when device-health probing fails after saving the account", async () => {
    listMatrixOwnDevicesMock.mockRejectedValue(new Error("homeserver unavailable"));
    await runMatrixCli(matrixAccountPasswordArgs());

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops");
    expect(console.error).toHaveBeenCalledWith(
      "Matrix device health warning: homeserver unavailable",
    );
  });

  it("returns device-health warnings in JSON mode without failing the account add command", async () => {
    listMatrixOwnDevicesMock.mockRejectedValue(new Error("homeserver unavailable"));
    await runMatrixCli(matrixAccountPasswordArgs("ops", "--json"));

    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const jsonOutput = stdoutWriteArg();
    expect(typeof jsonOutput).toBe("string");
    const payload = JSON.parse(String(jsonOutput)) as Record<string, unknown>;
    expect(payload.accountId).toBe("ops");
    expectRecordFields(payload.deviceHealth, {
      currentDeviceId: null,
      staleOpenClawDeviceIds: [],
      error: "homeserver unavailable",
    });
  });

  it("uses --name as fallback account id and prints account-scoped config path", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    await runMatrixCli([
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
    ]);

    expectRecordFields(mockCallArg(matrixSetupValidateInputMock), { accountId: "main-bot" });
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: main-bot");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.main-bot");
    const profileArg = mockCallArg(updateMatrixOwnProfileMock) as Record<string, unknown>;
    expect(profileArg.cfg).toBeTypeOf("object");
    expectRecordFields(profileArg, {
      accountId: "main-bot",
      displayName: "Main Bot",
    });
    expect(console.log).toHaveBeenCalledWith(
      "Bind this account to an agent: openclaw agents bind --agent <id> --bind matrix:main-bot",
    );
  });

  it("forwards --avatar-url through account add setup and profile sync", async () => {
    matrixRuntimeLoadConfigMock.mockReturnValue({ channels: {} });
    mockMatrixAccountConfigApply();
    await runMatrixCli([
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
    ]);

    const applyArg = mockCallArg(matrixSetupApplyAccountConfigMock) as Record<string, unknown>;
    expect(applyArg.accountId).toBe("ops-bot");
    expectRecordFields(applyArg.input, {
      name: "Ops Bot",
      homeserver: "https://matrix.example.org",
      accessToken: "ops-token",
      avatarUrl: "mxc://example/ops-avatar",
    });
    const profileArg = mockCallArg(updateMatrixOwnProfileMock) as {
      cfg?: CoreConfig;
      accountId?: string;
      displayName?: string;
      avatarUrl?: string;
    };
    expect(profileArg.cfg?.channels?.matrix?.accounts?.["ops-bot"]?.homeserver).toBe(
      "https://matrix.example.org",
    );
    expectRecordFields(profileArg, {
      accountId: "ops-bot",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example/ops-avatar",
    });
    expect(console.log).toHaveBeenCalledWith("Saved matrix account: ops-bot");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.ops-bot");
  });

  it("sets profile name and avatar via profile set command", async () => {
    await runMatrixCli([
      "matrix",
      "profile",
      "set",
      "--account",
      "alerts",
      "--name",
      "Alerts Bot",
      "--avatar-url",
      "mxc://example/avatar",
    ]);

    expectRecordFields(mockCallArg(updateMatrixOwnProfileMock), {
      accountId: "alerts",
      displayName: "Alerts Bot",
      avatarUrl: "mxc://example/avatar",
    });
    expect(matrixRuntimeReplaceConfigFileMock).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("Account: alerts");
    expect(console.log).toHaveBeenCalledWith("Config path: channels.matrix.accounts.alerts");
  });

  it("returns JSON errors for invalid account setup input", async () => {
    matrixSetupValidateInputMock.mockReturnValue("Matrix requires --homeserver");
    await runMatrixCli(["matrix", "account", "add", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stdoutWriteArg(0)))).toEqual({
      error: "Matrix requires --homeserver",
    });
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
    await runMatrixCli(["matrix", "verify", "bootstrap", "--json"]);

    expect(process.exitCode).toBe(0);
  });

  it("prints local timezone timestamps for verify status output in verbose mode", async () => {
    const recoveryCreatedAt = "2026-02-25T20:10:11.000Z";
    mockMatrixVerificationStatus({ recoveryKeyCreatedAt: recoveryCreatedAt });
    await runMatrixCli(["matrix", "verify", "status", "--verbose"]);

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
      verification: matrixVerificationState({
        recoveryKeyId: "SSSS",
        recoveryKeyCreatedAt: recoveryCreatedAt,
      }),
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
      ...matrixVerificationState({
        recoveryKeyId: "SSSS",
        recoveryKeyCreatedAt: recoveryCreatedAt,
        verifiedAt,
      }),
      success: true,
    });
    await runMatrixCli(["matrix", "verify", "bootstrap", "--verbose"]);
    await runMatrixCli(["matrix", "verify", "device", "valid-key", "--verbose"]);

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
    await runMatrixCli(["matrix", "verify", "status"]);

    expect(console.log).not.toHaveBeenCalledWith(
      `Recovery key created at: ${formatExpectedLocalTimestamp(recoveryCreatedAt)}`,
    );
    expect(console.log).not.toHaveBeenCalledWith("Pending verifications: 0");
    expect(console.log).not.toHaveBeenCalledWith("Diagnostics:");
    expect(console.log).toHaveBeenCalledWith("Backup: active and trusted on this device");
    expect(setMatrixSdkLogModeMock).toHaveBeenCalledWith("quiet");
  });

  for (const scenario of [
    {
      name: "shows explicit backup issue in default status output",
      status: {
        backupVersion: "5256",
        backup: diagnosticMatrixBackup({
          serverVersion: "5256",
          activeVersion: null,
          matchesDecryptionKey: false,
          decryptionKeyCached: false,
          keyLoadAttempted: true,
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      },
      expectedLogs: [
        "Backup issue: backup decryption key is not loaded on this device (secret storage did not return a key)",
        "- Backup key is not loaded on this device. Run openclaw matrix verify backup restore to load it and restore old room keys. If restore still cannot load the key, run the shown printf pipeline with the Matrix recovery key env var for this account: printf '%s\\n' \"$MATRIX_RECOVERY_KEY\" | openclaw matrix verify backup restore --recovery-key-stdin.",
      ],
      absentLogs: [
        "- Backup is present but not trusted for this device. Re-run 'openclaw matrix verify device <key>'.",
      ],
    },
    {
      name: "fails status with re-login guidance when the current Matrix device is missing on the server",
      status: {
        verified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        serverDeviceKnown: false,
        backupVersion: null,
        backup: diagnosticMatrixBackup({
          serverVersion: null,
          activeVersion: null,
          trusted: null,
          matchesDecryptionKey: null,
          decryptionKeyCached: true,
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      },
      expectedExitCode: 1,
      expectedLogs: [
        "Device issue: current Matrix device is missing from the homeserver device list",
        "- This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with openclaw matrix account add --homeserver '<url>' --user-id '<@user:server>' --password '<password>' --device-name OpenClaw-Gateway. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run openclaw matrix account add --homeserver '<url>' --access-token '<token>'.",
      ],
    },
    {
      name: "includes key load failure details in status output",
      status: {
        backupVersion: "5256",
        backup: diagnosticMatrixBackup({
          serverVersion: "5256",
          activeVersion: null,
          matchesDecryptionKey: false,
          decryptionKeyCached: false,
          keyLoadAttempted: true,
          keyLoadError: "secret storage key is not available",
        }),
        recoveryKeyCreatedAt: "2026-02-25T20:10:11.000Z",
      },
      expectedLogs: [
        "Backup issue: backup decryption key could not be loaded from secret storage (secret storage key is not available)",
      ],
    },
    {
      name: "includes backup reset guidance when the backup key does not match this device",
      status: {
        backupVersion: "21868",
        backup: diagnosticMatrixBackup({
          serverVersion: "21868",
          activeVersion: "21868",
          matchesDecryptionKey: false,
        }),
        recoveryKeyCreatedAt: "2026-03-09T14:40:00.000Z",
      },
      expectedLogs: [
        "- If you want a fresh backup baseline and accept losing unrecoverable history, run openclaw matrix verify backup reset --yes. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.",
      ],
    },
  ]) {
    it(scenario.name, async () => {
      getMatrixVerificationStatusMock.mockResolvedValue(matrixVerificationStatus(scenario.status));
      await runMatrixCli(["matrix", "verify", "status"]);

      if ("expectedExitCode" in scenario) {
        expect(process.exitCode).toBe(scenario.expectedExitCode);
      }
      for (const message of scenario.expectedLogs) {
        expect(console.log).toHaveBeenCalledWith(message);
      }
      for (const message of scenario.absentLogs ?? []) {
        expect(console.log).not.toHaveBeenCalledWith(message);
      }
    });
  }

  it("requires --yes before resetting the Matrix room-key backup", async () => {
    await runMatrixCli(["matrix", "verify", "backup", "reset"]);

    expect(process.exitCode).toBe(1);
    expect(resetMatrixRoomKeyBackupMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Backup reset failed: Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run openclaw matrix verify backup reset --yes.",
    );
  });

  it("resets the Matrix room-key backup when confirmed", async () => {
    await runMatrixCli(["matrix", "verify", "backup", "reset", "--yes"]);

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
    await runMatrixCli(["matrix", "verify", "backup", "reset", "--yes", "--rotate-recovery-key"]);

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
    getMatrixVerificationStatusMock.mockResolvedValue(
      matrixVerificationStatus({
        verified: false,
        localVerified: false,
        crossSigningVerified: false,
        signedByOwner: false,
        backupVersion: null,
        backup: diagnosticMatrixBackup({
          serverVersion: null,
          activeVersion: null,
          trusted: null,
          matchesDecryptionKey: null,
          decryptionKeyCached: null,
        }),
        recoveryKeyStored: false,
      }),
    );
    await runMatrixCli(["matrix", "verify", "status"]);

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
    getMatrixRoomKeyBackupStatusMock.mockResolvedValue(
      diagnosticMatrixBackup({
        serverVersion: "2",
        activeVersion: null,
        matchesDecryptionKey: false,
        decryptionKeyCached: false,
        keyLoadAttempted: true,
      }),
    );
    await runMatrixCli(["matrix", "verify", "backup", "status", "--verbose"]);

    expect(console.log).toHaveBeenCalledWith("Backup server version: 2");
    expect(console.log).toHaveBeenCalledWith("Backup active on this device: no");
    expect(console.log).toHaveBeenCalledWith("Backup trusted by this device: yes");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
