import type { Command } from "commander";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatZonedTimestamp } from "openclaw/plugin-sdk/matrix-runtime-shared";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/setup";
import { resolveMatrixAccount, resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } from "./matrix/actions/devices.js";
import { updateMatrixOwnProfile } from "./matrix/actions/profile.js";
import {
  acceptMatrixVerification,
  bootstrapMatrixVerification,
  cancelMatrixVerification,
  confirmMatrixVerificationSas,
  getMatrixVerificationSas,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  listMatrixVerifications,
  mismatchMatrixVerificationSas,
  requestMatrixVerification,
  resetMatrixRoomKeyBackup,
  restoreMatrixRoomKeyBackup,
  runMatrixSelfVerification,
  startMatrixVerification,
  verifyMatrixRecoveryKey,
} from "./matrix/actions/verification.js";
import { resolveMatrixRoomKeyBackupIssue } from "./matrix/backup-health.js";
import { resolveMatrixAuthContext } from "./matrix/client.js";
import { setMatrixSdkConsoleLogging, setMatrixSdkLogMode } from "./matrix/client/logging.js";
import { resolveMatrixConfigPath, updateMatrixAccountConfig } from "./matrix/config-update.js";
import { isOpenClawManagedMatrixDevice } from "./matrix/device-health.js";
import type { MatrixDirectRoomCandidate } from "./matrix/direct-management.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import { applyMatrixProfileUpdate, type MatrixProfileUpdateResult } from "./profile-update.js";
import { getMatrixRuntime } from "./runtime.js";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

let matrixCliExitScheduled = false;
type MatrixActionClientModule = typeof import("./matrix/actions/client.js");
type MatrixDirectManagementModule = typeof import("./matrix/direct-management.js");

let matrixActionClientModulePromise: Promise<MatrixActionClientModule> | undefined;
let matrixDirectManagementModulePromise: Promise<MatrixDirectManagementModule> | undefined;

function loadMatrixActionClientModule(): Promise<MatrixActionClientModule> {
  matrixActionClientModulePromise ??= import("./matrix/actions/client.js");
  return matrixActionClientModulePromise;
}

function loadMatrixDirectManagementModule(): Promise<MatrixDirectManagementModule> {
  matrixDirectManagementModulePromise ??= import("./matrix/direct-management.js");
  return matrixDirectManagementModulePromise;
}

export function resetMatrixCliStateForTests(): void {
  matrixCliExitScheduled = false;
}

function scheduleMatrixCliExit(): void {
  if (matrixCliExitScheduled || process.env.VITEST) {
    return;
  }
  matrixCliExitScheduled = true;
  // matrix-js-sdk rust crypto can leave background async work alive after command completion.
  setTimeout(() => {
    process.stdout.write("", () => {
      process.stderr.write("", () => {
        process.exit(process.exitCode ?? 0);
      });
    });
  }, 0);
}

function markCliFailure(): void {
  process.exitCode = 1;
}

async function readMatrixCliRecoveryKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const recoveryKey = Buffer.concat(chunks).toString("utf8").trim();
  if (!recoveryKey) {
    throw new Error("Matrix recovery key was requested from stdin, but stdin was empty.");
  }
  return recoveryKey;
}

async function resolveMatrixCliRecoveryKeyInput(options: {
  recoveryKey?: string;
  recoveryKeyStdin?: boolean;
}): Promise<string | undefined> {
  if (options.recoveryKey && options.recoveryKeyStdin === true) {
    throw new Error("Use either --recovery-key or --recovery-key-stdin, not both.");
  }
  if (options.recoveryKeyStdin === true) {
    return await readMatrixCliRecoveryKeyFromStdin();
  }
  return options.recoveryKey;
}

async function requireMatrixCliRecoveryKeyInput(options: {
  recoveryKey?: string;
  recoveryKeyStdin?: boolean;
}): Promise<string> {
  const recoveryKey = await resolveMatrixCliRecoveryKeyInput(options);
  if (!recoveryKey) {
    throw new Error(
      "Matrix recovery key is required. Pass --recovery-key-stdin to read it from stdin.",
    );
  }
  return recoveryKey;
}

function toErrorMessage(err: unknown): string {
  return formatMatrixErrorMessage(err);
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function formatLocalTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return formatZonedTimestamp(parsed, { displaySeconds: true }) ?? value;
}

function printTimestamp(label: string, value: string | null | undefined): void {
  const formatted = formatLocalTimestamp(value);
  if (formatted) {
    console.log(`${label}: ${formatMatrixCliText(formatted)}`);
  }
}

function printAccountLabel(accountId?: string): void {
  console.log(`Account: ${formatMatrixCliText(normalizeAccountId(accountId))}`);
}

function resolveMatrixCliAccountId(accountId?: string): string {
  return resolveMatrixCliAccountContext(accountId).accountId;
}

function resolveMatrixCliAccountContext(accountId?: string): {
  accountId: string;
  cfg: CoreConfig;
} {
  const cfg = getMatrixRuntime().config.loadConfig() as CoreConfig;
  return {
    accountId: resolveMatrixAuthContext({ cfg, accountId }).accountId,
    cfg,
  };
}

function formatMatrixCliCommand(command: string, accountId?: string): string {
  return formatMatrixCliCommandParts(command.split(" "), accountId);
}

function formatMatrixCliRecoveryKeyStdinCommand(command: string, accountId?: string): string {
  const normalizedAccountId = normalizeAccountId(accountId);
  const envName =
    normalizedAccountId === "default"
      ? "MATRIX_RECOVERY_KEY"
      : `MATRIX_RECOVERY_KEY_${normalizedAccountId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return `printf '%s\\n' "$${envName}" | ${formatMatrixCliCommand(command, accountId)}`;
}

function formatMatrixCliCommandParts(parts: string[], accountId?: string): string {
  const normalizedAccountId = normalizeAccountId(accountId);
  const command = ["openclaw", "matrix", ...parts];
  if (normalizedAccountId !== "default") {
    const optionTerminatorIndex = command.indexOf("--");
    if (optionTerminatorIndex >= 0) {
      command.splice(optionTerminatorIndex, 0, "--account", normalizedAccountId);
    } else {
      command.push("--account", normalizedAccountId);
    }
  }
  return command.map(formatMatrixCliShellArg).join(" ");
}

function formatMatrixCliShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatMatrixCliText(value: string | null | undefined, fallback = "unknown"): string {
  return sanitizeMatrixCliText(value ?? fallback);
}

function printMatrixOwnDevices(
  devices: Array<{
    deviceId: string;
    displayName: string | null;
    lastSeenIp: string | null;
    lastSeenTs: number | null;
    current: boolean;
  }>,
): void {
  if (devices.length === 0) {
    console.log("Devices: none");
    return;
  }
  for (const device of devices) {
    const labels = [device.current ? "current" : null, device.displayName]
      .filter((label): label is string => Boolean(label))
      .map((label) => formatMatrixCliText(label));
    console.log(
      `- ${formatMatrixCliText(device.deviceId)}${labels.length ? ` (${labels.join(", ")})` : ""}`,
    );
    if (device.lastSeenTs) {
      printTimestamp("  Last seen", new Date(device.lastSeenTs).toISOString());
    }
    if (device.lastSeenIp) {
      console.log(`  Last IP: ${formatMatrixCliText(device.lastSeenIp)}`);
    }
  }
}

function configureCliLogMode(verbose: boolean): void {
  setMatrixSdkLogMode(verbose ? "default" : "quiet");
  setMatrixSdkConsoleLogging(verbose);
}

function parseOptionalInt(value: string | undefined, fieldName: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  return parsed;
}

type MatrixCliAccountAddResult = {
  accountId: string;
  configPath: string;
  useEnv: boolean;
  deviceHealth: {
    currentDeviceId: string | null;
    staleOpenClawDeviceIds: string[];
    error?: string;
  };
  verificationBootstrap: {
    attempted: boolean;
    success: boolean;
    recoveryKeyCreatedAt: string | null;
    backupVersion: string | null;
    error?: string;
  };
  profile: {
    attempted: boolean;
    displayNameUpdated: boolean;
    avatarUpdated: boolean;
    resolvedAvatarUrl: string | null;
    convertedAvatarFromHttp: boolean;
    error?: string;
  };
};

async function addMatrixAccount(params: {
  account?: string;
  name?: string;
  avatarUrl?: string;
  homeserver?: string;
  proxy?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
  deviceName?: string;
  initialSyncLimit?: string;
  allowPrivateNetwork?: boolean;
  useEnv?: boolean;
}): Promise<MatrixCliAccountAddResult> {
  const runtime = getMatrixRuntime();
  const cfg = runtime.config.loadConfig() as CoreConfig;
  if (!matrixSetupAdapter.applyAccountConfig) {
    throw new Error("Matrix account setup is unavailable.");
  }

  const input: ChannelSetupInput = {
    name: params.name,
    avatarUrl: params.avatarUrl,
    homeserver: params.homeserver,
    dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
    proxy: params.proxy,
    userId: params.userId,
    accessToken: params.accessToken,
    password: params.password,
    deviceName: params.deviceName,
    initialSyncLimit: parseOptionalInt(params.initialSyncLimit, "--initial-sync-limit"),
    useEnv: params.useEnv === true,
  };
  const accountId =
    matrixSetupAdapter.resolveAccountId?.({
      cfg,
      accountId: params.account,
      input,
    }) ?? normalizeAccountId(params.account?.trim() || params.name?.trim());
  const validationError = matrixSetupAdapter.validateInput?.({
    cfg,
    accountId,
    input,
  });
  if (validationError) {
    throw new Error(validationError);
  }

  const updated = matrixSetupAdapter.applyAccountConfig({
    cfg,
    accountId,
    input,
  }) as CoreConfig;
  await runtime.config.writeConfigFile(updated as never);
  const accountConfig = resolveMatrixAccountConfig({ cfg: updated, accountId });

  let verificationBootstrap: MatrixCliAccountAddResult["verificationBootstrap"] = {
    attempted: false,
    success: false,
    recoveryKeyCreatedAt: null,
    backupVersion: null,
  };
  if (accountConfig.encryption === true) {
    const { maybeBootstrapNewEncryptedMatrixAccount } = await import("./setup-bootstrap.js");
    verificationBootstrap = await maybeBootstrapNewEncryptedMatrixAccount({
      previousCfg: cfg,
      cfg: updated,
      accountId,
    });
  }

  const desiredDisplayName = input.name?.trim();
  const desiredAvatarUrl = input.avatarUrl?.trim();
  let profile: MatrixCliAccountAddResult["profile"] = {
    attempted: false,
    displayNameUpdated: false,
    avatarUpdated: false,
    resolvedAvatarUrl: null,
    convertedAvatarFromHttp: false,
  };
  if (desiredDisplayName || desiredAvatarUrl) {
    try {
      const synced = await updateMatrixOwnProfile({
        accountId,
        displayName: desiredDisplayName,
        avatarUrl: desiredAvatarUrl,
      });
      let resolvedAvatarUrl = synced.resolvedAvatarUrl;
      if (synced.convertedAvatarFromHttp && synced.resolvedAvatarUrl) {
        const latestCfg = runtime.config.loadConfig() as CoreConfig;
        const withAvatar = updateMatrixAccountConfig(latestCfg, accountId, {
          avatarUrl: synced.resolvedAvatarUrl,
        });
        await runtime.config.writeConfigFile(withAvatar as never);
        resolvedAvatarUrl = synced.resolvedAvatarUrl;
      }
      profile = {
        attempted: true,
        displayNameUpdated: synced.displayNameUpdated,
        avatarUpdated: synced.avatarUpdated,
        resolvedAvatarUrl,
        convertedAvatarFromHttp: synced.convertedAvatarFromHttp,
      };
    } catch (err) {
      profile = {
        attempted: true,
        displayNameUpdated: false,
        avatarUpdated: false,
        resolvedAvatarUrl: null,
        convertedAvatarFromHttp: false,
        error: toErrorMessage(err),
      };
    }
  }

  let deviceHealth: MatrixCliAccountAddResult["deviceHealth"] = {
    currentDeviceId: null,
    staleOpenClawDeviceIds: [],
  };
  try {
    const addedDevices = await listMatrixOwnDevices({ accountId, cfg: updated });
    deviceHealth = {
      currentDeviceId: addedDevices.find((device) => device.current)?.deviceId ?? null,
      staleOpenClawDeviceIds: addedDevices
        .filter((device) => !device.current && isOpenClawManagedMatrixDevice(device.displayName))
        .map((device) => device.deviceId),
    };
  } catch (err) {
    deviceHealth = {
      currentDeviceId: null,
      staleOpenClawDeviceIds: [],
      error: toErrorMessage(err),
    };
  }

  return {
    accountId,
    configPath: resolveMatrixConfigPath(updated, accountId),
    useEnv: input.useEnv === true,
    deviceHealth,
    verificationBootstrap,
    profile,
  };
}

function printDirectRoomCandidate(room: MatrixCliDirectRoomCandidate): void {
  const members =
    room.joinedMembers === null
      ? "unavailable"
      : room.joinedMembers.map((member) => formatMatrixCliText(member)).join(", ") || "none";
  console.log(
    `- ${formatMatrixCliText(room.roomId)} [${room.source}] strict=${
      room.strict ? "yes" : "no"
    } joined=${members}`,
  );
}

function printDirectRoomInspection(result: MatrixCliDirectRoomInspection): void {
  printAccountLabel(result.accountId);
  console.log(`Peer: ${formatMatrixCliText(result.remoteUserId)}`);
  console.log(`Self: ${formatMatrixCliText(result.selfUserId)}`);
  console.log(`Active direct room: ${formatMatrixCliText(result.activeRoomId, "none")}`);
  console.log(
    `Mapped rooms: ${
      result.mappedRoomIds.length
        ? result.mappedRoomIds.map((roomId) => formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  console.log(
    `Discovered strict rooms: ${
      result.discoveredStrictRoomIds.length
        ? result.discoveredStrictRoomIds.map((roomId) => formatMatrixCliText(roomId)).join(", ")
        : "none"
    }`,
  );
  if (result.mappedRooms.length > 0) {
    console.log("Mapped room details:");
    for (const room of result.mappedRooms) {
      printDirectRoomCandidate(room);
    }
  }
}

async function inspectMatrixDirectRoom(params: {
  accountId: string;
  userId: string;
}): Promise<MatrixCliDirectRoomInspection> {
  const cfg = getMatrixRuntime().config.loadConfig() as CoreConfig;
  const [{ withResolvedActionClient }, { inspectMatrixDirectRooms }] = await Promise.all([
    loadMatrixActionClientModule(),
    loadMatrixDirectManagementModule(),
  ]);
  return await withResolvedActionClient(
    { accountId: params.accountId, cfg },
    async (client) => {
      const inspection = await inspectMatrixDirectRooms({
        client,
        remoteUserId: params.userId,
      });
      return {
        accountId: params.accountId,
        remoteUserId: inspection.remoteUserId,
        selfUserId: inspection.selfUserId,
        mappedRoomIds: inspection.mappedRoomIds,
        mappedRooms: inspection.mappedRooms.map(toCliDirectRoomCandidate),
        discoveredStrictRoomIds: inspection.discoveredStrictRoomIds,
        activeRoomId: inspection.activeRoomId,
      };
    },
    "persist",
  );
}

async function repairMatrixDirectRoom(params: {
  accountId: string;
  userId: string;
}): Promise<MatrixCliDirectRoomRepair> {
  const cfg = getMatrixRuntime().config.loadConfig() as CoreConfig;
  const account = resolveMatrixAccount({ cfg, accountId: params.accountId });
  const [{ withStartedActionClient }, { repairMatrixDirectRooms }] = await Promise.all([
    loadMatrixActionClientModule(),
    loadMatrixDirectManagementModule(),
  ]);
  return await withStartedActionClient({ accountId: params.accountId, cfg }, async (client) => {
    const repaired = await repairMatrixDirectRooms({
      client,
      remoteUserId: params.userId,
      encrypted: account.config.encryption === true,
    });
    return {
      accountId: params.accountId,
      remoteUserId: repaired.remoteUserId,
      selfUserId: repaired.selfUserId,
      mappedRoomIds: repaired.mappedRoomIds,
      mappedRooms: repaired.mappedRooms.map(toCliDirectRoomCandidate),
      discoveredStrictRoomIds: repaired.discoveredStrictRoomIds,
      activeRoomId: repaired.activeRoomId,
      encrypted: account.config.encryption === true,
      createdRoomId: repaired.createdRoomId,
      changed: repaired.changed,
      directContentBefore: repaired.directContentBefore,
      directContentAfter: repaired.directContentAfter,
    };
  });
}

type MatrixCliProfileSetResult = MatrixProfileUpdateResult;

async function setMatrixProfile(params: {
  account?: string;
  name?: string;
  avatarUrl?: string;
}): Promise<MatrixCliProfileSetResult> {
  return await applyMatrixProfileUpdate({
    account: params.account,
    displayName: params.name,
    avatarUrl: params.avatarUrl,
  });
}

type MatrixCliCommandConfig<TResult> = {
  verbose: boolean;
  json: boolean;
  run: () => Promise<TResult>;
  onText: (result: TResult, verbose: boolean) => void;
  onJson?: (result: TResult) => unknown;
  shouldFail?: (result: TResult) => boolean;
  errorPrefix: string;
  onJsonError?: (message: string) => unknown;
  onTextError?: (message: string) => void;
};

async function runMatrixCliCommand<TResult>(
  config: MatrixCliCommandConfig<TResult>,
): Promise<void> {
  configureCliLogMode(config.verbose);
  try {
    const result = await config.run();
    if (config.json) {
      printJson(config.onJson ? config.onJson(result) : result);
    } else {
      config.onText(result, config.verbose);
    }
    if (config.shouldFail?.(result)) {
      markCliFailure();
    }
  } catch (err) {
    const message = toErrorMessage(err);
    if (config.json) {
      printJson(config.onJsonError ? config.onJsonError(message) : { error: message });
    } else {
      console.error(`${config.errorPrefix}: ${formatMatrixCliText(message)}`);
      config.onTextError?.(message);
    }
    markCliFailure();
  } finally {
    scheduleMatrixCliExit();
  }
}

type MatrixCliBackupStatus = {
  serverVersion: string | null;
  activeVersion: string | null;
  trusted: boolean | null;
  matchesDecryptionKey: boolean | null;
  decryptionKeyCached: boolean | null;
  keyLoadAttempted: boolean;
  keyLoadError: string | null;
};

type MatrixCliVerificationStatus = {
  encryptionEnabled: boolean;
  verified: boolean;
  userId: string | null;
  deviceId: string | null;
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
  serverDeviceKnown?: boolean | null;
  recoveryKeyStored: boolean;
  recoveryKeyCreatedAt: string | null;
  pendingVerifications: number;
  recoveryKeyAccepted?: boolean;
  backupUsable?: boolean;
  deviceOwnerVerified?: boolean;
};

type MatrixCliVerificationCommandOptions = {
  account?: string;
  userId?: string;
  roomId?: string;
  verbose?: boolean;
  json?: boolean;
};

type MatrixCliSelfVerificationCommandOptions = {
  account?: string;
  timeoutMs?: string;
  verbose?: boolean;
};

type MatrixCliVerificationSummary = {
  id: string;
  transactionId?: string;
  roomId?: string;
  otherUserId: string;
  otherDeviceId?: string;
  isSelfVerification: boolean;
  initiatedByMe: boolean;
  phaseName: string;
  pending: boolean;
  methods: string[];
  chosenMethod?: string | null;
  hasSas: boolean;
  sas?: MatrixCliVerificationSas;
  completed: boolean;
  error?: string;
};

type MatrixCliVerificationSas = {
  decimal?: [number, number, number];
  emoji?: Array<[string, string]>;
};

type MatrixCliDirectRoomCandidate = {
  roomId: string;
  source: "account-data" | "joined";
  strict: boolean;
  joinedMembers: string[] | null;
};

type MatrixCliDirectRoomInspection = {
  accountId: string;
  remoteUserId: string;
  selfUserId: string | null;
  mappedRoomIds: string[];
  mappedRooms: MatrixCliDirectRoomCandidate[];
  discoveredStrictRoomIds: string[];
  activeRoomId: string | null;
};

type MatrixCliDirectRoomRepair = MatrixCliDirectRoomInspection & {
  encrypted: boolean;
  createdRoomId: string | null;
  changed: boolean;
  directContentBefore: Record<string, string[]>;
  directContentAfter: Record<string, string[]>;
};

function toCliDirectRoomCandidate(room: MatrixDirectRoomCandidate): MatrixCliDirectRoomCandidate {
  return {
    roomId: room.roomId,
    source: room.source,
    strict: room.strict,
    joinedMembers: room.joinedMembers,
  };
}

function resolveBackupStatus(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): MatrixCliBackupStatus {
  return {
    serverVersion: status.backup?.serverVersion ?? status.backupVersion ?? null,
    activeVersion: status.backup?.activeVersion ?? null,
    trusted: status.backup?.trusted ?? null,
    matchesDecryptionKey: status.backup?.matchesDecryptionKey ?? null,
    decryptionKeyCached: status.backup?.decryptionKeyCached ?? null,
    keyLoadAttempted: status.backup?.keyLoadAttempted ?? false,
    keyLoadError: status.backup?.keyLoadError ?? null,
  };
}

function yesNoUnknown(value: boolean | null): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

function printBackupStatus(backup: MatrixCliBackupStatus): void {
  console.log(`Backup server version: ${formatMatrixCliText(backup.serverVersion, "none")}`);
  console.log(`Backup active on this device: ${formatMatrixCliText(backup.activeVersion, "no")}`);
  console.log(`Backup trusted by this device: ${yesNoUnknown(backup.trusted)}`);
  console.log(`Backup matches local decryption key: ${yesNoUnknown(backup.matchesDecryptionKey)}`);
  console.log(`Backup key cached locally: ${yesNoUnknown(backup.decryptionKeyCached)}`);
  console.log(`Backup key load attempted: ${yesNoUnknown(backup.keyLoadAttempted)}`);
  if (backup.keyLoadError) {
    console.log(`Backup key load error: ${formatMatrixCliText(backup.keyLoadError)}`);
  }
}

function printVerificationIdentity(status: {
  userId: string | null;
  deviceId: string | null;
}): void {
  console.log(`User: ${formatMatrixCliText(status.userId)}`);
  console.log(`Device: ${formatMatrixCliText(status.deviceId)}`);
}

function printVerificationBackupSummary(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): void {
  printBackupSummary(resolveBackupStatus(status));
}

function printVerificationBackupStatus(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): void {
  printBackupStatus(resolveBackupStatus(status));
}

function printVerificationTrustDiagnostics(status: {
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
}): void {
  console.log(`Locally trusted: ${status.localVerified ? "yes" : "no"}`);
  console.log(`Cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}`);
  console.log(`Signed by owner: ${status.signedByOwner ? "yes" : "no"}`);
}

function sanitizeMatrixCliText(value: string): string {
  let withoutAnsi = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x9b) {
      index++;
      while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) {
        index++;
      }
      continue;
    }
    if (code === 0x9d) {
      index++;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current === 0x07 || current === 0x9c) {
          break;
        }
        if (current === 0x1b && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (code === 0x90 || code === 0x9e || code === 0x9f) {
      index++;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current === 0x07 || current === 0x9c) {
          break;
        }
        if (current === 0x1b && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (code !== 0x1b) {
      withoutAnsi += value[index];
      continue;
    }

    const marker = value[index + 1];
    if (marker === "[") {
      index += 2;
      while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) {
        index++;
      }
      continue;
    }
    if (marker === "]") {
      index += 2;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current === 0x07) {
          break;
        }
        if (current === 0x1b && value[index + 1] === "\\") {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    index++;
  }

  let sanitized = "";
  for (const character of withoutAnsi) {
    const code = character.charCodeAt(0);
    if (!isUnsafeMatrixCliTerminalCode(code)) {
      sanitized += character;
    }
  }
  return sanitized;
}

function isUnsafeMatrixCliTerminalCode(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function isAnsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function formatMatrixCliSasEmoji(emoji: NonNullable<MatrixCliVerificationSas["emoji"]>): string {
  return emoji
    .map(
      ([emojiValue, label]) =>
        `${sanitizeMatrixCliText(emojiValue)} ${sanitizeMatrixCliText(label)}`,
    )
    .join(" | ");
}

function printMatrixVerificationSummary(summary: MatrixCliVerificationSummary): void {
  console.log(`Verification id: ${sanitizeMatrixCliText(summary.id)}`);
  if (summary.transactionId) {
    console.log(`Transaction id: ${sanitizeMatrixCliText(summary.transactionId)}`);
  }
  if (summary.roomId) {
    console.log(`Room id: ${sanitizeMatrixCliText(summary.roomId)}`);
  }
  console.log(`Other user: ${sanitizeMatrixCliText(summary.otherUserId)}`);
  console.log(`Other device: ${sanitizeMatrixCliText(summary.otherDeviceId ?? "unknown")}`);
  console.log(`Self-verification: ${summary.isSelfVerification ? "yes" : "no"}`);
  console.log(`Initiated by OpenClaw: ${summary.initiatedByMe ? "yes" : "no"}`);
  console.log(`Phase: ${sanitizeMatrixCliText(summary.phaseName)}`);
  console.log(`Pending: ${summary.pending ? "yes" : "no"}`);
  console.log(`Completed: ${summary.completed ? "yes" : "no"}`);
  console.log(
    `Methods: ${
      summary.methods.length ? summary.methods.map(sanitizeMatrixCliText).join(", ") : "none"
    }`,
  );
  if (summary.chosenMethod) {
    console.log(`Chosen method: ${sanitizeMatrixCliText(summary.chosenMethod)}`);
  }
  if (summary.hasSas && summary.sas?.emoji?.length) {
    console.log(`SAS emoji: ${formatMatrixCliSasEmoji(summary.sas.emoji)}`);
  } else if (summary.hasSas && summary.sas?.decimal) {
    console.log(`SAS decimals: ${summary.sas.decimal.join(" ")}`);
  }
  if (summary.error) {
    console.log(`Verification error: ${sanitizeMatrixCliText(summary.error)}`);
  }
}

function printMatrixVerificationSummaries(summaries: MatrixCliVerificationSummary[]): void {
  if (summaries.length === 0) {
    console.log("Verifications: none");
    return;
  }
  summaries.forEach((summary, index) => {
    if (index > 0) {
      console.log("");
    }
    printMatrixVerificationSummary(summary);
  });
}

function printMatrixVerificationSas(sas: MatrixCliVerificationSas): void {
  if (sas.emoji?.length) {
    console.log(`SAS emoji: ${formatMatrixCliSasEmoji(sas.emoji)}`);
  } else if (sas.decimal) {
    console.log(`SAS decimals: ${sas.decimal.join(" ")}`);
  } else {
    console.log("SAS: unavailable");
  }
}

function matrixCliVerificationDmLookupOptions(options: MatrixCliVerificationCommandOptions): {
  verificationDmRoomId?: string;
  verificationDmUserId?: string;
} {
  const lookup: {
    verificationDmRoomId?: string;
    verificationDmUserId?: string;
  } = {};
  if (options.roomId !== undefined) {
    lookup.verificationDmRoomId = options.roomId;
  }
  if (options.userId !== undefined) {
    lookup.verificationDmUserId = options.userId;
  }
  return lookup;
}

function formatMatrixVerificationDmFollowupParts(params: {
  roomId?: string;
  userId?: string;
}): string[] {
  if (!params.roomId || !params.userId) {
    return [];
  }
  return [
    "--user-id",
    sanitizeMatrixCliText(params.userId),
    "--room-id",
    sanitizeMatrixCliText(params.roomId),
  ];
}

function formatMatrixVerificationSummaryDmFollowupParts(
  summary: MatrixCliVerificationSummary,
): string[] {
  return formatMatrixVerificationDmFollowupParts({
    roomId: summary.roomId,
    userId: summary.otherUserId,
  });
}

function formatMatrixVerificationOptionsDmFollowupParts(
  options: MatrixCliVerificationCommandOptions,
): string[] {
  return formatMatrixVerificationDmFollowupParts({
    roomId: options.roomId,
    userId: options.userId,
  });
}

function formatMatrixVerificationPreferredDmFollowupParts(
  summary: MatrixCliVerificationSummary,
  options: MatrixCliVerificationCommandOptions,
): string[] {
  const summaryParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
  return summaryParts.length
    ? summaryParts
    : formatMatrixVerificationOptionsDmFollowupParts(options);
}

function formatMatrixVerificationFollowupCommand(params: {
  action: string;
  requestId: string;
  accountId?: string;
  dmParts?: string[];
}): string {
  return formatMatrixCliCommandParts(
    ["verify", params.action, ...(params.dmParts ?? []), "--", params.requestId],
    params.accountId,
  );
}

function printMatrixVerificationSasGuidance(
  requestId: string,
  accountId?: string,
  dmParts: string[] = [],
): void {
  printGuidance([
    `Compare the emoji or decimals with the other Matrix client.`,
    `If they match, run ${formatMatrixVerificationFollowupCommand({ action: "confirm-sas", requestId, accountId, dmParts })}.`,
    `If they do not match, run ${formatMatrixVerificationFollowupCommand({ action: "mismatch-sas", requestId, accountId, dmParts })}.`,
  ]);
}

function formatMatrixVerificationCommandId(summary: MatrixCliVerificationSummary): string {
  return sanitizeMatrixCliText(summary.transactionId ?? summary.id);
}

async function promptMatrixVerificationSasMatch(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question("Do the emoji or decimals match? Type yes to confirm: ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function printMatrixVerificationRequestGuidance(
  summary: MatrixCliVerificationSummary,
  accountId?: string,
): void {
  const requestId = formatMatrixVerificationCommandId(summary);
  const dmParts = formatMatrixVerificationSummaryDmFollowupParts(summary);
  printGuidance([
    `Accept the verification request in another Matrix client for this account.`,
    `Then run ${formatMatrixVerificationFollowupCommand({ action: "start", requestId, accountId, dmParts })} to start SAS verification.`,
    `Run ${formatMatrixVerificationFollowupCommand({ action: "sas", requestId, accountId, dmParts })} to display the SAS emoji or decimals.`,
    `When the SAS matches, run ${formatMatrixVerificationFollowupCommand({ action: "confirm-sas", requestId, accountId, dmParts })}.`,
  ]);
}

async function runMatrixCliVerificationSummaryCommand(params: {
  options: MatrixCliVerificationCommandOptions;
  run: (accountId: string, cfg: CoreConfig) => Promise<MatrixCliVerificationSummary>;
  afterText?: (summary: MatrixCliVerificationSummary, accountId: string) => void;
  errorPrefix: string;
}): Promise<void> {
  const { accountId, cfg } = resolveMatrixCliAccountContext(params.options.account);
  await runMatrixCliCommand({
    verbose: params.options.verbose === true,
    json: params.options.json === true,
    run: async () => await params.run(accountId, cfg),
    onText: (summary) => {
      printAccountLabel(accountId);
      printMatrixVerificationSummary(summary);
      params.afterText?.(summary, accountId);
    },
    errorPrefix: params.errorPrefix,
  });
}

async function runMatrixCliSelfVerificationCommand(
  options: MatrixCliSelfVerificationCommandOptions,
): Promise<void> {
  const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
  await runMatrixCliCommand({
    verbose: options.verbose === true,
    json: false,
    run: async () =>
      await runMatrixSelfVerification({
        accountId,
        cfg,
        timeoutMs: parseOptionalInt(options.timeoutMs, "--timeout-ms"),
        onRequested: (summary) => {
          printAccountLabel(accountId);
          printMatrixVerificationSummary(summary);
          console.log("Accept this verification request in another Matrix client.");
        },
        onReady: (summary) => {
          console.log("Verification request accepted.");
          if (!summary.hasSas) {
            console.log("Starting SAS verification...");
          }
        },
        onSas: (summary) => {
          printMatrixVerificationSas(summary.sas ?? {});
          console.log("Compare this SAS with the other Matrix client.");
        },
        confirmSas: async () => await promptMatrixVerificationSasMatch(),
      }),
    onText: (summary, verbose) => {
      printMatrixVerificationSummary(summary);
      console.log(`Device verified by owner: ${summary.deviceOwnerVerified ? "yes" : "no"}`);
      printVerificationTrustDiagnostics(summary.ownerVerification);
      printVerificationBackupSummary(summary.ownerVerification);
      if (verbose) {
        printVerificationBackupStatus(summary.ownerVerification);
      }
      console.log("Self-verification complete.");
    },
    onTextError: () => {
      printGuidance([
        `Run ${formatMatrixCliCommand("verify self", accountId)} again and accept the request in another verified Matrix client for this account.`,
        `Then run ${formatMatrixCliCommand("verify status --verbose", accountId)} to confirm Cross-signing verified: yes and Signed by owner: yes.`,
      ]);
    },
    errorPrefix: "Self-verification failed",
  });
}

function printVerificationGuidance(status: MatrixCliVerificationStatus, accountId?: string): void {
  printGuidance(buildVerificationGuidance(status, accountId));
}

function printBackupGuidance(
  backup: MatrixCliBackupStatus,
  accountId?: string,
  options: { recoveryKeyStored?: boolean } = {},
): void {
  printGuidance(buildBackupGuidance(backup, accountId, options));
}

function printBackupSummary(backup: MatrixCliBackupStatus): void {
  const issue = resolveMatrixRoomKeyBackupIssue(backup);
  console.log(`Backup: ${issue.summary}`);
  if (backup.serverVersion) {
    console.log(`Backup version: ${formatMatrixCliText(backup.serverVersion)}`);
  }
}

function buildVerificationGuidance(
  status: MatrixCliVerificationStatus,
  accountId?: string,
): string[] {
  const backup = resolveBackupStatus(status);
  const nextSteps = new Set<string>();
  if (!status.verified) {
    if (status.recoveryKeyAccepted === true && status.backupUsable === true) {
      nextSteps.add(
        `Recovery key can unlock the room-key backup, but full Matrix identity trust is still incomplete. Run ${formatMatrixCliCommand("verify self", accountId)}, accept the request in another verified Matrix client, and confirm the SAS only if it matches.`,
      );
      nextSteps.add(
        `If you intend to replace the current cross-signing identity, run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify bootstrap --recovery-key-stdin --force-reset-cross-signing", accountId)}.`,
      );
    } else {
      nextSteps.add(
        `Run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify device --recovery-key-stdin", accountId)}. If you do not have the recovery key but still have another verified Matrix client, run ${formatMatrixCliCommand("verify self", accountId)} instead.`,
      );
    }
  }
  if (status.serverDeviceKnown === false) {
    nextSteps.add(
      `This Matrix device is no longer listed on the homeserver. Create a new OpenClaw Matrix device with ${formatMatrixCliCommand("account add --homeserver <url> --user-id <@user:server> --password <password> --device-name OpenClaw-Gateway", accountId)}. If you use token auth, create a fresh Matrix access token in your Matrix client or admin UI, then run ${formatMatrixCliCommand("account add --homeserver <url> --access-token <token>", accountId)}.`,
    );
  }
  for (const step of buildBackupGuidance(backup, accountId, {
    recoveryKeyStored: status.recoveryKeyStored,
  })) {
    nextSteps.add(step);
  }
  if (status.pendingVerifications > 0) {
    nextSteps.add(
      `Review pending verification requests with ${formatMatrixCliCommand("verify list", accountId)}. Complete each active request with ${formatMatrixCliCommand("verify sas <id>", accountId)} and ${formatMatrixCliCommand("verify confirm-sas <id>", accountId)}, or cancel stale requests with ${formatMatrixCliCommand("verify cancel <id>", accountId)}.`,
    );
  }
  return Array.from(nextSteps);
}

function buildBackupGuidance(
  backup: MatrixCliBackupStatus,
  accountId?: string,
  options: { recoveryKeyStored?: boolean } = {},
): string[] {
  const backupIssue = resolveMatrixRoomKeyBackupIssue(backup);
  const nextSteps = new Set<string>();
  if (backupIssue.code === "missing-server-backup") {
    nextSteps.add(
      `Run ${formatMatrixCliCommand("verify bootstrap", accountId)} to create a room key backup.`,
    );
  } else if (
    backupIssue.code === "key-load-failed" ||
    backupIssue.code === "key-not-loaded" ||
    backupIssue.code === "inactive"
  ) {
    if (options.recoveryKeyStored) {
      nextSteps.add(
        `Backup key is not loaded on this device. Run ${formatMatrixCliCommand("verify backup restore", accountId)} to load it and restore old room keys. If restore still cannot load the key, run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)}.`,
      );
    } else {
      nextSteps.add(
        `Run the shown printf pipeline with the Matrix recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)} to load the server backup and store the key for future restores.`,
      );
    }
  } else if (backupIssue.code === "key-mismatch") {
    nextSteps.add(
      `Backup key mismatch on this device. Run the shown printf pipeline with the active server backup recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify backup restore --recovery-key-stdin", accountId)}.`,
    );
    nextSteps.add(
      `If you want a fresh backup baseline and accept losing unrecoverable history, run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.`,
    );
  } else if (backupIssue.code === "untrusted-signature") {
    nextSteps.add(
      `Backup trust chain is not verified on this device. Run the shown printf pipeline with the correct recovery key env var for this account: ${formatMatrixCliRecoveryKeyStdinCommand("verify device --recovery-key-stdin", accountId)}.`,
    );
    nextSteps.add(
      `If device identity trust remains incomplete after that, run ${formatMatrixCliCommand("verify self", accountId)} from another verified Matrix client.`,
    );
    nextSteps.add(
      `If you want a fresh backup baseline and accept losing unrecoverable history, run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}. Add --rotate-recovery-key only when the old recovery key should stop unlocking the fresh backup.`,
    );
  } else if (backupIssue.code === "indeterminate") {
    nextSteps.add(
      `Run ${formatMatrixCliCommand("verify status --verbose", accountId)} to inspect backup trust diagnostics.`,
    );
  }
  return Array.from(nextSteps);
}

function printGuidance(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log("Next steps:");
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function printVerificationStatus(
  status: MatrixCliVerificationStatus,
  verbose = false,
  accountId?: string,
): void {
  console.log(`Verified by owner: ${status.verified ? "yes" : "no"}`);
  if (status.serverDeviceKnown === false) {
    console.log("Device issue: current Matrix device is missing from the homeserver device list");
  }
  const backup = resolveBackupStatus(status);
  const backupIssue = resolveMatrixRoomKeyBackupIssue(backup);
  printVerificationBackupSummary(status);
  if (backupIssue.message) {
    console.log(`Backup issue: ${backupIssue.message}`);
  }
  if (verbose) {
    console.log("Diagnostics:");
    printVerificationIdentity(status);
    if (status.serverDeviceKnown !== undefined) {
      console.log(`Device present on server: ${yesNoUnknown(status.serverDeviceKnown ?? null)}`);
    }
    printVerificationTrustDiagnostics(status);
    printVerificationBackupStatus(status);
    console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
    printTimestamp("Recovery key created at", status.recoveryKeyCreatedAt);
    console.log(`Pending verifications: ${status.pendingVerifications}`);
  } else {
    console.log(`Recovery key stored: ${status.recoveryKeyStored ? "yes" : "no"}`);
  }
  printVerificationGuidance(status, accountId);
}

export function registerMatrixCli(params: { program: Command }): void {
  const root = params.program
    .command("matrix")
    .description("Matrix channel utilities")
    .addHelpText("after", () => "\nDocs: https://docs.openclaw.ai/channels/matrix\n");

  const account = root.command("account").description("Manage matrix channel accounts");

  account
    .command("add")
    .description("Add or update a matrix account (wrapper around channel setup)")
    .option("--account <id>", "Account ID (default: normalized --name, else default)")
    .option("--name <name>", "Optional display name for this account")
    .option("--avatar-url <url>", "Optional Matrix avatar URL (mxc:// or http(s) URL)")
    .option("--homeserver <url>", "Matrix homeserver URL")
    .option("--proxy <url>", "Optional HTTP(S) proxy URL for Matrix requests")
    .option(
      "--allow-private-network",
      "Allow Matrix homeserver traffic to private/internal hosts for this account",
    )
    .option("--user-id <id>", "Matrix user ID")
    .option("--access-token <token>", "Matrix access token")
    .option("--password <password>", "Matrix password")
    .option("--device-name <name>", "Matrix device display name")
    .option("--initial-sync-limit <n>", "Matrix initial sync limit")
    .option(
      "--use-env",
      "Use MATRIX_* env vars (or MATRIX_<ACCOUNT_ID>_* for non-default accounts)",
    )
    .option("--verbose", "Show setup details")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        name?: string;
        avatarUrl?: string;
        homeserver?: string;
        proxy?: string;
        allowPrivateNetwork?: boolean;
        userId?: string;
        accessToken?: string;
        password?: string;
        deviceName?: string;
        initialSyncLimit?: string;
        useEnv?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await addMatrixAccount({
              account: options.account,
              name: options.name,
              avatarUrl: options.avatarUrl,
              homeserver: options.homeserver,
              proxy: options.proxy,
              allowPrivateNetwork: options.allowPrivateNetwork === true,
              userId: options.userId,
              accessToken: options.accessToken,
              password: options.password,
              deviceName: options.deviceName,
              initialSyncLimit: options.initialSyncLimit,
              useEnv: options.useEnv === true,
            }),
          onText: (result) => {
            console.log(`Saved matrix account: ${formatMatrixCliText(result.accountId)}`);
            console.log(`Config path: ${formatMatrixCliText(result.configPath)}`);
            console.log(
              `Credentials source: ${result.useEnv ? "MATRIX_* / MATRIX_<ACCOUNT_ID>_* env vars" : "inline config"}`,
            );
            if (result.verificationBootstrap.attempted) {
              if (result.verificationBootstrap.success) {
                console.log("Matrix verification bootstrap: complete");
                printTimestamp(
                  "Recovery key created at",
                  result.verificationBootstrap.recoveryKeyCreatedAt,
                );
                if (result.verificationBootstrap.backupVersion) {
                  console.log(
                    `Backup version: ${formatMatrixCliText(result.verificationBootstrap.backupVersion)}`,
                  );
                }
              } else {
                console.error(
                  `Matrix verification bootstrap warning: ${formatMatrixCliText(result.verificationBootstrap.error)}`,
                );
              }
            }
            if (result.deviceHealth.error) {
              console.error(
                `Matrix device health warning: ${formatMatrixCliText(result.deviceHealth.error)}`,
              );
            } else if (result.deviceHealth.staleOpenClawDeviceIds.length > 0) {
              const staleDeviceIds = result.deviceHealth.staleOpenClawDeviceIds
                .map((deviceId) => formatMatrixCliText(deviceId))
                .join(", ");
              console.log(
                `Matrix device hygiene warning: stale OpenClaw devices detected (${staleDeviceIds}). Run ${formatMatrixCliCommand("devices prune-stale", result.accountId)}.`,
              );
            }
            if (result.profile.attempted) {
              if (result.profile.error) {
                console.error(`Profile sync warning: ${formatMatrixCliText(result.profile.error)}`);
              } else {
                console.log(
                  `Profile sync: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`,
                );
                if (result.profile.convertedAvatarFromHttp && result.profile.resolvedAvatarUrl) {
                  console.log(
                    `Avatar converted and saved as: ${formatMatrixCliText(result.profile.resolvedAvatarUrl)}`,
                  );
                }
              }
            }
            const bindHint = `openclaw agents bind --agent <id> --bind matrix:${result.accountId}`;
            console.log(`Bind this account to an agent: ${bindHint}`);
          },
          errorPrefix: "Account setup failed",
        });
      },
    );

  const profile = root.command("profile").description("Manage Matrix bot profile");

  profile
    .command("set")
    .description("Update Matrix profile display name and/or avatar")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--name <name>", "Profile display name")
    .option("--avatar-url <url>", "Profile avatar URL (mxc:// or http(s) URL)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        name?: string;
        avatarUrl?: string;
        verbose?: boolean;
        json?: boolean;
      }) => {
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await setMatrixProfile({
              account: options.account,
              name: options.name,
              avatarUrl: options.avatarUrl,
            }),
          onText: (result) => {
            printAccountLabel(result.accountId);
            console.log(`Config path: ${result.configPath}`);
            console.log(
              `Profile update: name ${result.profile.displayNameUpdated ? "updated" : "unchanged"}, avatar ${result.profile.avatarUpdated ? "updated" : "unchanged"}`,
            );
            if (result.profile.convertedAvatarFromHttp && result.avatarUrl) {
              console.log(
                `Avatar converted and saved as: ${formatMatrixCliText(result.avatarUrl)}`,
              );
            }
          },
          errorPrefix: "Profile update failed",
        });
      },
    );

  const direct = root.command("direct").description("Inspect and repair Matrix direct-room state");

  direct
    .command("inspect")
    .description("Inspect direct-room mappings for a Matrix user")
    .requiredOption("--user-id <id>", "Peer Matrix user ID")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: { userId: string; account?: string; verbose?: boolean; json?: boolean }) => {
        const accountId = resolveMatrixCliAccountId(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await inspectMatrixDirectRoom({
              accountId,
              userId: options.userId,
            }),
          onText: (result) => {
            printDirectRoomInspection(result);
          },
          errorPrefix: "Direct room inspection failed",
        });
      },
    );

  direct
    .command("repair")
    .description("Repair Matrix direct-room mappings for a Matrix user")
    .requiredOption("--user-id <id>", "Peer Matrix user ID")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: { userId: string; account?: string; verbose?: boolean; json?: boolean }) => {
        const accountId = resolveMatrixCliAccountId(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await repairMatrixDirectRoom({
              accountId,
              userId: options.userId,
            }),
          onText: (result, verbose) => {
            printDirectRoomInspection(result);
            console.log(`Encrypted room creation: ${result.encrypted ? "enabled" : "disabled"}`);
            console.log(`Created room: ${formatMatrixCliText(result.createdRoomId, "none")}`);
            console.log(`m.direct updated: ${result.changed ? "yes" : "no"}`);
            if (verbose) {
              console.log(
                `m.direct before: ${formatMatrixCliText(JSON.stringify(result.directContentBefore[result.remoteUserId] ?? []))}`,
              );
              console.log(
                `m.direct after: ${formatMatrixCliText(JSON.stringify(result.directContentAfter[result.remoteUserId] ?? []))}`,
              );
            }
          },
          errorPrefix: "Direct room repair failed",
        });
      },
    );

  const verify = root.command("verify").description("Device verification for Matrix E2EE");

  verify
    .command("list")
    .description("List pending Matrix verification requests")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
      await runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await listMatrixVerifications({ accountId, cfg }),
        onText: (summaries) => {
          printAccountLabel(accountId);
          printMatrixVerificationSummaries(summaries);
        },
        errorPrefix: "Verification listing failed",
      });
    });

  verify
    .command("self")
    .description("Interactively self-verify this Matrix device")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--timeout-ms <ms>", "How long to wait for the other Matrix client")
    .option("--verbose", "Show detailed diagnostics")
    .action(async (options: MatrixCliSelfVerificationCommandOptions) => {
      await runMatrixCliSelfVerificationCommand(options);
    });

  verify
    .command("request")
    .description("Request Matrix device verification from another Matrix client")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--own-user", "Request self-verification for this Matrix account")
    .option("--user-id <id>", "Matrix user ID to verify")
    .option("--device-id <id>", "Matrix device ID to verify")
    .option("--room-id <id>", "Matrix direct-message room ID for verification")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        ownUser?: boolean;
        userId?: string;
        deviceId?: string;
        roomId?: string;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () => {
            if (
              options.ownUser === true &&
              (options.userId || options.deviceId || options.roomId)
            ) {
              throw new Error(
                "--own-user cannot be combined with --user-id, --device-id, or --room-id",
              );
            }
            return await requestMatrixVerification({
              accountId,
              cfg,
              ownUser: options.ownUser === true ? true : undefined,
              userId: options.userId,
              deviceId: options.deviceId,
              roomId: options.roomId,
            });
          },
          onText: (summary) => {
            printAccountLabel(accountId);
            printMatrixVerificationSummary(summary);
            printMatrixVerificationRequestGuidance(summary, accountId);
          },
          errorPrefix: "Verification request failed",
        });
      },
    );

  verify
    .command("accept <id>")
    .description("Accept an inbound Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await acceptMatrixVerification(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        afterText: (summary, accountId) => {
          const requestId = formatMatrixVerificationCommandId(summary);
          const dmParts = formatMatrixVerificationPreferredDmFollowupParts(summary, options);
          printGuidance([
            `Run ${formatMatrixVerificationFollowupCommand({ action: "start", requestId, accountId, dmParts })} to start SAS verification.`,
          ]);
        },
        errorPrefix: "Verification accept failed",
      });
    });

  verify
    .command("start <id>")
    .description("Start SAS verification for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await startMatrixVerification(id, {
            accountId,
            cfg,
            method: "sas",
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        afterText: (summary, accountId) =>
          printMatrixVerificationSasGuidance(
            formatMatrixVerificationCommandId(summary),
            accountId,
            formatMatrixVerificationPreferredDmFollowupParts(summary, options),
          ),
        errorPrefix: "Verification start failed",
      });
    });

  verify
    .command("sas <id>")
    .description("Show SAS emoji or decimals for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: MatrixCliVerificationCommandOptions) => {
      const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
      await runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () =>
          await getMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        onText: (sas) => {
          const requestId = formatMatrixCliText(id);
          printAccountLabel(accountId);
          console.log(`Verification id: ${requestId}`);
          printMatrixVerificationSas(sas);
          printMatrixVerificationSasGuidance(
            requestId,
            accountId,
            formatMatrixVerificationOptionsDmFollowupParts(options),
          );
        },
        errorPrefix: "Verification SAS lookup failed",
      });
    });

  verify
    .command("confirm-sas <id>")
    .description("Confirm matching SAS emoji or decimals for a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await confirmMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        errorPrefix: "Verification SAS confirm failed",
      });
    });

  verify
    .command("mismatch-sas <id>")
    .description("Reject a Matrix SAS verification when the emoji or decimals do not match")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: MatrixCliVerificationCommandOptions) => {
      await runMatrixCliVerificationSummaryCommand({
        options,
        run: async (accountId, cfg) =>
          await mismatchMatrixVerificationSas(id, {
            accountId,
            cfg,
            ...matrixCliVerificationDmLookupOptions(options),
          }),
        errorPrefix: "Verification SAS mismatch failed",
      });
    });

  verify
    .command("cancel <id>")
    .description("Cancel a Matrix verification request")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--user-id <id>", "Matrix user ID for DM verification follow-up")
    .option("--room-id <id>", "Matrix direct-message room ID for verification follow-up")
    .option("--reason <text>", "Cancellation reason")
    .option("--code <code>", "Matrix cancellation code")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        options: MatrixCliVerificationCommandOptions & {
          reason?: string;
          code?: string;
        },
      ) => {
        await runMatrixCliVerificationSummaryCommand({
          options,
          run: async (accountId, cfg) =>
            await cancelMatrixVerification(id, {
              accountId,
              cfg,
              reason: options.reason,
              code: options.code,
              ...matrixCliVerificationDmLookupOptions(options),
            }),
          errorPrefix: "Verification cancel failed",
        });
      },
    );

  verify
    .command("status")
    .description("Check Matrix device verification status")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--include-recovery-key", "Include stored recovery key in output")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        verbose?: boolean;
        includeRecoveryKey?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await getMatrixVerificationStatus({
              accountId,
              cfg,
              includeRecoveryKey: options.includeRecoveryKey === true,
            }),
          onText: (status, verbose) => {
            printAccountLabel(accountId);
            printVerificationStatus(status, verbose, accountId);
          },
          shouldFail: (status) => status.serverDeviceKnown === false,
          errorPrefix: "Error",
        });
      },
    );

  const backup = verify.command("backup").description("Matrix room-key backup health and restore");

  backup
    .command("status")
    .description("Show Matrix room-key backup status for this device")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
      await runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await getMatrixRoomKeyBackupStatus({ accountId, cfg }),
        onText: (status, verbose) => {
          printAccountLabel(accountId);
          printBackupSummary(status);
          if (verbose) {
            printBackupStatus(status);
          }
          printBackupGuidance(status, accountId);
        },
        errorPrefix: "Backup status failed",
      });
    });

  backup
    .command("reset")
    .description(
      "Delete the current server backup and create a fresh room-key backup baseline, repairing secret storage if needed for a durable reset",
    )
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--yes", "Confirm destructive backup reset", false)
    .option("--rotate-recovery-key", "Create a new Matrix recovery key for the fresh backup")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        yes?: boolean;
        rotateRecoveryKey?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () => {
            if (options.yes !== true) {
              throw new Error(
                `Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run ${formatMatrixCliCommand("verify backup reset --yes", accountId)}.`,
              );
            }
            return await resetMatrixRoomKeyBackup({
              accountId,
              cfg,
              rotateRecoveryKey: options.rotateRecoveryKey === true,
            });
          },
          onText: (result, verbose) => {
            printAccountLabel(accountId);
            console.log(`Reset success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${formatMatrixCliText(result.error)}`);
            }
            console.log(
              `Previous backup version: ${formatMatrixCliText(result.previousVersion, "none")}`,
            );
            console.log(
              `Deleted backup version: ${formatMatrixCliText(result.deletedVersion, "none")}`,
            );
            console.log(
              `Current backup version: ${formatMatrixCliText(result.createdVersion, "none")}`,
            );
            printBackupSummary(result.backup);
            if (verbose) {
              printTimestamp("Reset at", result.resetAt);
              printBackupStatus(result.backup);
            }
            printBackupGuidance(result.backup, accountId);
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Backup reset failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  backup
    .command("restore")
    .description("Restore encrypted room keys from server backup")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option(
      "--recovery-key <key>",
      "Optional recovery key to load before restoring (prefer --recovery-key-stdin)",
    )
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        recoveryKeyStdin?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await restoreMatrixRoomKeyBackup({
              accountId,
              cfg,
              recoveryKey: await resolveMatrixCliRecoveryKeyInput(options),
            }),
          onText: (result, verbose) => {
            printAccountLabel(accountId);
            console.log(`Restore success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${formatMatrixCliText(result.error)}`);
            }
            console.log(`Backup version: ${formatMatrixCliText(result.backupVersion, "none")}`);
            console.log(`Imported keys: ${result.imported}/${result.total}`);
            printBackupSummary(result.backup);
            if (verbose) {
              console.log(
                `Loaded key from secret storage: ${result.loadedFromSecretStorage ? "yes" : "no"}`,
              );
              printTimestamp("Restored at", result.restoredAt);
              printBackupStatus(result.backup);
            }
            printBackupGuidance(result.backup, accountId, {
              recoveryKeyStored: result.loadedFromSecretStorage,
            });
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Backup restore failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  verify
    .command("bootstrap")
    .description("Bootstrap Matrix cross-signing and device verification state")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option(
      "--recovery-key <key>",
      "Recovery key to apply before bootstrap (prefer --recovery-key-stdin)",
    )
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option("--force-reset-cross-signing", "Force reset cross-signing identity before bootstrap")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        recoveryKeyStdin?: boolean;
        forceResetCrossSigning?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await bootstrapMatrixVerification({
              accountId,
              cfg,
              recoveryKey: await resolveMatrixCliRecoveryKeyInput(options),
              forceResetCrossSigning: options.forceResetCrossSigning === true,
            }),
          onText: (result, verbose) => {
            printAccountLabel(accountId);
            console.log(`Bootstrap success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${formatMatrixCliText(result.error)}`);
            }
            console.log(`Verified by owner: ${result.verification.verified ? "yes" : "no"}`);
            printVerificationIdentity(result.verification);
            if (verbose) {
              printVerificationTrustDiagnostics(result.verification);
              console.log(
                `Cross-signing published: ${result.crossSigning.published ? "yes" : "no"} (master=${result.crossSigning.masterKeyPublished ? "yes" : "no"}, self=${result.crossSigning.selfSigningKeyPublished ? "yes" : "no"}, user=${result.crossSigning.userSigningKeyPublished ? "yes" : "no"})`,
              );
              printVerificationBackupStatus(result.verification);
              printTimestamp("Recovery key created at", result.verification.recoveryKeyCreatedAt);
              console.log(`Pending verifications: ${result.pendingVerifications}`);
            } else {
              console.log(
                `Cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`,
              );
              printVerificationBackupSummary(result.verification);
            }
            printVerificationGuidance(
              {
                ...result.verification,
                pendingVerifications: result.pendingVerifications,
              },
              accountId,
            );
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Verification bootstrap failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  verify
    .command("device [key]")
    .description("Verify device using a Matrix recovery key")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (
        key: string | undefined,
        options: {
          account?: string;
          recoveryKeyStdin?: boolean;
          verbose?: boolean;
          json?: boolean;
        },
      ) => {
        const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
        await runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await verifyMatrixRecoveryKey(
              await requireMatrixCliRecoveryKeyInput({
                recoveryKey: key,
                recoveryKeyStdin: options.recoveryKeyStdin,
              }),
              { accountId, cfg },
            ),
          onText: (result, verbose) => {
            printAccountLabel(accountId);
            if (!result.success) {
              console.error(`Verification failed: ${formatMatrixCliText(result.error)}`);
              printVerificationIdentity(result);
              console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
              console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
              console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
              printVerificationBackupSummary(result);
              if (verbose) {
                printVerificationTrustDiagnostics(result);
                printVerificationBackupStatus(result);
                printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
              }
              printVerificationGuidance(
                {
                  ...result,
                  pendingVerifications: 0,
                },
                accountId,
              );
              return;
            }
            console.log("Device verification completed successfully.");
            printVerificationIdentity(result);
            console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
            console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
            console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
            printVerificationBackupSummary(result);
            if (verbose) {
              printVerificationTrustDiagnostics(result);
              printVerificationBackupStatus(result);
              printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
              printTimestamp("Verified at", result.verifiedAt);
            }
            printVerificationGuidance(
              {
                ...result,
                pendingVerifications: 0,
              },
              accountId,
            );
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Verification failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  const devices = root.command("devices").description("Inspect and clean up Matrix devices");

  devices
    .command("list")
    .description("List server-side Matrix devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
      await runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await listMatrixOwnDevices({ accountId, cfg }),
        onText: (result) => {
          printAccountLabel(accountId);
          printMatrixOwnDevices(result);
        },
        errorPrefix: "Device listing failed",
      });
    });

  devices
    .command("prune-stale")
    .description("Delete stale OpenClaw-managed devices for this account")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = resolveMatrixCliAccountContext(options.account);
      await runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await pruneMatrixStaleGatewayDevices({ accountId, cfg }),
        onText: (result, verbose) => {
          printAccountLabel(accountId);
          console.log(
            `Deleted stale OpenClaw devices: ${
              result.deletedDeviceIds.length
                ? result.deletedDeviceIds
                    .map((deviceId) => formatMatrixCliText(deviceId))
                    .join(", ")
                : "none"
            }`,
          );
          console.log(`Current device: ${formatMatrixCliText(result.currentDeviceId)}`);
          console.log(`Remaining devices: ${result.remainingDevices.length}`);
          if (verbose) {
            console.log("Devices before cleanup:");
            printMatrixOwnDevices(result.before);
            console.log("Devices after cleanup:");
            printMatrixOwnDevices(result.remainingDevices);
          }
        },
        errorPrefix: "Device cleanup failed",
      });
    });
}
