import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { readByteStreamWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { resolveMatrixRoomKeyBackupIssue } from "./matrix/backup-health.js";
import { resolveMatrixAuthContext } from "./matrix/client.js";
import { setMatrixSdkConsoleLogging, setMatrixSdkLogMode } from "./matrix/client/logging.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import type { MatrixOwnDeviceVerificationStatus, MatrixRoomKeyBackupStatus } from "./matrix/sdk.js";
import type { MatrixVerificationSummary } from "./matrix/sdk/verification-manager.js";
import { formatZonedTimestamp } from "./runtime-api.js";
import { getMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export { formatMatrixErrorMessage };

let matrixCliExitScheduled = false;
const MATRIX_CLI_RECOVERY_KEY_STDIN_MAX_BYTES = 1024 * 1024;

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
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: MATRIX_CLI_RECOVERY_KEY_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`Matrix recovery key stdin exceeds ${maxBytes} bytes.`),
  });
  const recoveryKey = bytes.toString("utf8").trim();
  if (!recoveryKey) {
    throw new Error("Matrix recovery key was requested from stdin, but stdin was empty.");
  }
  return recoveryKey;
}

export async function resolveMatrixCliRecoveryKeyInput(options: {
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

export async function requireMatrixCliRecoveryKeyInput(options: {
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

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function printTimestamp(label: string, value: string | null | undefined): void {
  if (!value) {
    return;
  }
  const parsed = new Date(value);
  const formatted = Number.isFinite(parsed.getTime())
    ? (formatZonedTimestamp(parsed, { displaySeconds: true }) ?? value)
    : value;
  console.log(`${label}: ${formatMatrixCliText(formatted)}`);
}

export function printAccountLabel(accountId?: string): void {
  console.log(`Account: ${formatMatrixCliText(normalizeAccountId(accountId))}`);
}

export function resolveMatrixCliAccountContext(accountId?: string): {
  accountId: string;
  cfg: CoreConfig;
} {
  const cfg = getMatrixRuntime().config.current() as CoreConfig;
  return {
    accountId: resolveMatrixAuthContext({ cfg, accountId }).accountId,
    cfg,
  };
}

export function formatMatrixCliCommand(command: string, accountId?: string): string {
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

export function formatMatrixCliCommandParts(parts: string[], accountId?: string): string {
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

export function formatMatrixCliText(
  value: string | null | undefined,
  fallback = "unknown",
): string {
  return sanitizeMatrixCliText(value ?? fallback);
}

function configureCliLogMode(verbose: boolean): void {
  setMatrixSdkLogMode(verbose ? "default" : "quiet");
  setMatrixSdkConsoleLogging(verbose);
}

export function parseOptionalInt(
  value: string | undefined,
  fieldName: string,
  opts: { min?: number } = {},
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  const parsed = parseStrictInteger(trimmed);
  if (parsed === undefined) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (opts.min !== undefined && parsed < opts.min) {
    throw new Error(
      opts.min === 1
        ? `${fieldName} must be a positive integer`
        : `${fieldName} must be a non-negative integer`,
    );
  }
  return parsed;
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

export async function runMatrixCliCommand<TResult>(
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
    const message = formatMatrixErrorMessage(err);
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

export function sanitizeMatrixCliText(value: string): string {
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

type MatrixCliBackupStatus = MatrixRoomKeyBackupStatus;

export type MatrixCliVerificationStatus = MatrixOwnDeviceVerificationStatus & {
  pendingVerifications: number;
  recoveryKeyAccepted?: boolean;
  backupUsable?: boolean;
  deviceOwnerVerified?: boolean;
};

export type MatrixCliVerificationCommandOptions = {
  account?: string;
  userId?: string;
  roomId?: string;
  verbose?: boolean;
  json?: boolean;
};

export type MatrixCliSelfVerificationCommandOptions = {
  account?: string;
  timeoutMs?: string;
  verbose?: boolean;
};

export type MatrixCliVerificationSummary = MatrixVerificationSummary;
type MatrixCliVerificationSas = NonNullable<MatrixVerificationSummary["sas"]>;

export function resolveBackupStatus(status: {
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

export function printBackupStatus(backup: MatrixCliBackupStatus): void {
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

export function printVerificationIdentity(status: {
  userId: string | null;
  deviceId: string | null;
}): void {
  console.log(`User: ${formatMatrixCliText(status.userId)}`);
  console.log(`Device: ${formatMatrixCliText(status.deviceId)}`);
}

export function printVerificationBackupSummary(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): void {
  printBackupSummary(resolveBackupStatus(status));
}

export function printVerificationBackupStatus(status: {
  backupVersion: string | null;
  backup?: MatrixCliBackupStatus;
}): void {
  printBackupStatus(resolveBackupStatus(status));
}

export function printVerificationTrustDiagnostics(status: {
  localVerified: boolean;
  crossSigningVerified: boolean;
  signedByOwner: boolean;
}): void {
  console.log(`Locally trusted: ${status.localVerified ? "yes" : "no"}`);
  console.log(`Cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}`);
  console.log(`Signed by owner: ${status.signedByOwner ? "yes" : "no"}`);
}

function formatMatrixCliSasEmoji(emoji: NonNullable<MatrixCliVerificationSas["emoji"]>): string {
  return emoji
    .map(
      ([emojiValue, label]) =>
        `${sanitizeMatrixCliText(emojiValue)} ${sanitizeMatrixCliText(label)}`,
    )
    .join(" | ");
}

export function printMatrixVerificationSummary(summary: MatrixCliVerificationSummary): void {
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

export function printMatrixVerificationSummaries(summaries: MatrixCliVerificationSummary[]): void {
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

export function printMatrixVerificationSas(sas: MatrixCliVerificationSas): void {
  if (sas.emoji?.length) {
    console.log(`SAS emoji: ${formatMatrixCliSasEmoji(sas.emoji)}`);
  } else if (sas.decimal) {
    console.log(`SAS decimals: ${sas.decimal.join(" ")}`);
  } else {
    console.log("SAS: unavailable");
  }
}

export function printVerificationGuidance(
  status: MatrixCliVerificationStatus,
  accountId?: string,
): void {
  printGuidance(buildVerificationGuidance(status, accountId));
}

export function printBackupGuidance(
  backup: MatrixCliBackupStatus,
  accountId?: string,
  options: { recoveryKeyStored?: boolean } = {},
): void {
  printGuidance(buildBackupGuidance(backup, accountId, options));
}

export function printBackupSummary(backup: MatrixCliBackupStatus): void {
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

export function printGuidance(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log("Next steps:");
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

export function printVerificationStatus(
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
