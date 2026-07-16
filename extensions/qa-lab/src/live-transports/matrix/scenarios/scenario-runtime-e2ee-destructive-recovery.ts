// QA Lab Matrix destructive E2EE CLI recovery helpers.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMatrixQaClient } from "../substrate/client.js";
import {
  createMatrixQaOpenClawCliRuntime,
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  type MatrixQaCliRunResult,
} from "./scenario-runtime-cli.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export type MatrixQaCliRuntime = Awaited<ReturnType<typeof createMatrixQaOpenClawCliRuntime>>;

export type MatrixQaCliBackupStatus = {
  backup?: {
    decryptionKeyCached?: boolean | null;
    keyLoadError?: string | null;
    matchesDecryptionKey?: boolean | null;
    trusted?: boolean | null;
  };
  backupVersion?: string | null;
  error?: string;
  imported?: number;
  loadedFromSecretStorage?: boolean;
  success?: boolean;
  total?: number;
};

export type MatrixQaCliVerificationStatus = {
  backup?: MatrixQaCliBackupStatus["backup"];
  crossSigningVerified?: boolean;
  deviceId?: string | null;
  serverDeviceKnown?: boolean | null;
  error?: string;
  recoveryKeyAccepted?: boolean;
  backupUsable?: boolean;
  deviceOwnerVerified?: boolean;
  recoveryKeyStored?: boolean;
  signedByOwner?: boolean;
  success?: boolean;
  userId?: string | null;
  verified?: boolean;
};

export function requireMatrixQaE2eeOutputDir(context: MatrixQaScenarioContext) {
  if (!context.outputDir) {
    throw new Error("Matrix E2EE destructive QA scenarios require an output directory");
  }
  return context.outputDir;
}

function requireMatrixQaCliRuntimeEnv(context: MatrixQaScenarioContext) {
  if (!context.gatewayRuntimeEnv) {
    throw new Error(
      "Matrix E2EE destructive CLI scenarios require the gateway runtime environment",
    );
  }
  return context.gatewayRuntimeEnv;
}

export function requireMatrixQaGatewayConfigPath(context: MatrixQaScenarioContext) {
  const configPath = requireMatrixQaCliRuntimeEnv(context).OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("Matrix E2EE destructive QA scenarios require the gateway config path");
  }
  return configPath;
}

export async function createMatrixQaRecoveryCliRuntime(params: {
  accountId: string;
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  label: string;
  userId: string;
}) {
  return await createMatrixQaOpenClawCliRuntime({
    accountId: params.accountId,
    accessToken: params.accessToken,
    artifactLabel: params.label,
    baseUrl: params.context.baseUrl,
    deviceId: params.deviceId,
    displayName: `Matrix QA ${params.label}`,
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    runtimeEnv: requireMatrixQaCliRuntimeEnv(params.context),
    userId: params.userId,
  });
}

export async function loginMatrixQaRecoveryDevice(params: {
  context: MatrixQaScenarioContext;
  deviceName: string;
  userId: string;
  password: string;
}): Promise<{
  accessToken: string;
  deviceId: string;
  password?: string;
  userId: string;
}> {
  const loginClient = createMatrixQaClient({ baseUrl: params.context.baseUrl });
  const device = await loginClient.loginWithPassword({
    deviceName: params.deviceName,
    password: params.password,
    userId: params.userId,
  });
  if (!device.deviceId) {
    throw new Error(`Matrix destructive recovery login did not return a device id`);
  }
  return {
    ...device,
    deviceId: device.deviceId,
  };
}

function parseMatrixQaCliJson(result: MatrixQaCliRunResult): unknown {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const payload = stdout || stderr;
  if (!payload) {
    throw new Error(`${formatMatrixQaCliCommand(result.args)} did not print JSON`);
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(
      `${formatMatrixQaCliCommand(result.args)} printed invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${redactMatrixQaCliOutput(payload)}`,
      { cause: error },
    );
  }
}

async function writeMatrixQaCliArtifacts(params: {
  label: string;
  result: MatrixQaCliRunResult;
  runtime: MatrixQaCliRuntime;
}) {
  await mkdir(params.runtime.artifactDir, { mode: 0o700, recursive: true });
  const safe = params.label.replace(/[^A-Za-z0-9_-]/g, "-");
  const stdoutPath = path.join(params.runtime.artifactDir, `${safe}.stdout.txt`);
  const stderrPath = path.join(params.runtime.artifactDir, `${safe}.stderr.txt`);
  await Promise.all([
    writeFile(stdoutPath, redactMatrixQaCliOutput(params.result.stdout), { mode: 0o600 }),
    writeFile(stderrPath, redactMatrixQaCliOutput(params.result.stderr), { mode: 0o600 }),
  ]);
  return { stderrPath, stdoutPath };
}

export async function runMatrixQaCliJson<T>(params: {
  allowNonZero?: boolean;
  args: string[];
  decode?: (payload: unknown) => T;
  label: string;
  runtime: MatrixQaCliRuntime;
  stdin?: string;
  timeoutMs: number;
}) {
  const result = await params.runtime.run(params.args, {
    allowNonZero: params.allowNonZero,
    stdin: params.stdin,
    timeoutMs: params.timeoutMs,
  });
  const artifacts = await writeMatrixQaCliArtifacts({
    label: params.label,
    result,
    runtime: params.runtime,
  });
  const parsed = parseMatrixQaCliJson(result);
  return {
    artifacts,
    payload: params.decode ? params.decode(parsed) : (parsed as T),
    result,
  };
}

export function assertMatrixQaCliBackupRestoreSucceeded(
  restore: MatrixQaCliBackupStatus,
  label: string,
) {
  if (restore.success !== true) {
    throw new Error(`${label} backup restore failed: ${restore.error ?? "unknown error"}`);
  }
  if (restore.backup?.keyLoadError) {
    throw new Error(
      `${label} backup restore left a backup key error: ${restore.backup.keyLoadError}`,
    );
  }
  if (restore.backup?.matchesDecryptionKey !== true) {
    throw new Error(`${label} backup restore did not load the matching backup key`);
  }
}

export function assertMatrixQaCliBackupRestoreFailed(
  restore: {
    payload: MatrixQaCliBackupStatus;
    result: Pick<MatrixQaCliRunResult, "exitCode">;
  },
  params: {
    expectedBackupVersion: string;
    failureKind: "missing-recovery-key" | "rejected-recovery-key";
    label: string;
  },
) {
  if (restore.result.exitCode === 0) {
    throw new Error(`${params.label} returned a successful exit code`);
  }
  if (restore.payload.success === true) {
    throw new Error(`${params.label} unexpectedly succeeded`);
  }
  if (!restore.payload.error) {
    throw new Error(`${params.label} failed without an actionable diagnostic`);
  }
  if (restore.payload.backupVersion !== params.expectedBackupVersion) {
    throw new Error(
      `${params.label} failed against backup ${restore.payload.backupVersion ?? "<none>"}; expected ${params.expectedBackupVersion}`,
    );
  }
  const backup = restore.payload.backup;
  const backupKeyUnusable =
    backup?.decryptionKeyCached === false ||
    backup?.matchesDecryptionKey === false ||
    Boolean(backup?.keyLoadError);
  if (!backupKeyUnusable) {
    throw new Error(`${params.label} failed without evidence that the backup key was rejected`);
  }
  // The Matrix CLI has no machine-readable backup issue code, so pin these to
  // its SDK diagnostics to keep transport/auth failures from satisfying QA.
  const error = restore.payload.error.toLowerCase();
  const keyLoadError = backup?.keyLoadError?.toLowerCase() ?? "";
  const expectedDiagnostic =
    params.failureKind === "missing-recovery-key"
      ? keyLoadError.includes("getsecretstoragekey callback returned falsey") ||
        (!keyLoadError &&
          backup?.decryptionKeyCached === false &&
          error.includes(
            "backup decryption key is not loaded on this device (secret storage did not return a key)",
          ))
      : ["bad mac", "backup key mismatch", "does not have the matching backup decryption key"].some(
          (expected) => keyLoadError.includes(expected),
        );
  if (!expectedDiagnostic) {
    throw new Error(`${params.label} failed without the expected ${params.failureKind} diagnostic`);
  }
}

export function isMatrixQaVerifyStatusHealthy(status: {
  payload: MatrixQaCliVerificationStatus;
  result: MatrixQaCliRunResult;
}) {
  return status.result.exitCode === 0 && status.payload.serverDeviceKnown !== false;
}

export function isMatrixQaDeletedDeviceStatus(params: {
  ownerDeviceListContainsDeletedDevice: boolean;
  status: {
    payload: MatrixQaCliVerificationStatus;
    result: MatrixQaCliRunResult;
  };
}) {
  const authInvalidated =
    params.status.result.exitCode !== 0 &&
    typeof params.status.payload.error === "string" &&
    (params.status.payload.error.includes("M_UNKNOWN_TOKEN") ||
      params.status.payload.error.toLowerCase().includes("access token"));
  const deviceMissing =
    params.status.payload.serverDeviceKnown === false ||
    !params.ownerDeviceListContainsDeletedDevice;
  return {
    authInvalidated,
    deviceMissing,
    invalidated: authInvalidated || deviceMissing,
  };
}

export async function runMatrixQaExternalKeyRestore(params: {
  accountId: string;
  context: MatrixQaScenarioContext;
  deviceName: string;
  label: string;
  password: string;
  userId: string;
}) {
  const device = await loginMatrixQaRecoveryDevice({
    context: params.context,
    deviceName: params.deviceName,
    password: params.password,
    userId: params.userId,
  });
  const cli = await createMatrixQaRecoveryCliRuntime({
    accountId: params.accountId,
    accessToken: device.accessToken,
    context: params.context,
    deviceId: device.deviceId,
    label: params.label,
    userId: device.userId,
  });
  return { cli, device };
}
