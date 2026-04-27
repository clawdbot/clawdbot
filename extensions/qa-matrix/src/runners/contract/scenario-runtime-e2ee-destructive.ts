import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createMatrixQaClient } from "../../substrate/client.js";
import {
  createMatrixQaE2eeScenarioClient,
  type MatrixQaE2eeScenarioClient,
} from "../../substrate/e2ee-client.js";
import { requestMatrixJson } from "../../substrate/request.js";
import {
  buildMatrixQaE2eeScenarioRoomKey,
  type MatrixQaE2eeScenarioId,
} from "./scenario-catalog.js";
import {
  createMatrixQaOpenClawCliRuntime,
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  type MatrixQaCliRunResult,
} from "./scenario-runtime-cli.js";
import {
  readMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount,
} from "./scenario-runtime-config.js";
import {
  assertTopLevelReplyArtifact,
  buildMentionPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMatrixQaToken,
  createMatrixQaDriverScenarioClient,
  isMatrixQaExactMarkerReply,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { waitForMatrixSyncStoreWithCursor } from "./scenario-runtime-state-files.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

type MatrixQaCliRuntime = Awaited<ReturnType<typeof createMatrixQaOpenClawCliRuntime>>;

type MatrixQaCliBackupStatus = {
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

type MatrixQaCliVerificationStatus = {
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

type MatrixQaDestructiveSetup = {
  encodedRecoveryKey: string;
  owner: MatrixQaE2eeScenarioClient;
  ownerAccessToken: string;
  ownerDeviceId: string;
  ownerPassword: string;
  ownerUserId: string;
  recoveryKeyId: string | null;
  roomId: string;
  roomKey: string;
  seededEventId: string;
};

async function cleanupMatrixQaTempDevices(
  client: MatrixQaE2eeScenarioClient,
  deviceIds: Array<string | null | undefined>,
): Promise<void> {
  await client.stop().catch(() => undefined);
  const uniqueDeviceIds = [
    ...new Set(deviceIds.filter((deviceId): deviceId is string => !!deviceId)),
  ];
  if (uniqueDeviceIds.length > 0) {
    await client.deleteOwnDevices(uniqueDeviceIds).catch(() => undefined);
  }
}

function requireMatrixQaE2eeOutputDir(context: MatrixQaScenarioContext) {
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

function requireMatrixQaGatewayConfigPath(context: MatrixQaScenarioContext) {
  const configPath = requireMatrixQaCliRuntimeEnv(context).OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("Matrix E2EE destructive QA scenarios require the gateway config path");
  }
  return configPath;
}

function requireMatrixQaPassword(context: MatrixQaScenarioContext, actor: "driver" | "observer") {
  const password = actor === "driver" ? context.driverPassword : context.observerPassword;
  if (!password) {
    throw new Error(`Matrix E2EE destructive ${actor} password is required`);
  }
  return password;
}

function requireMatrixQaRegistrationToken(context: MatrixQaScenarioContext) {
  const token = context.registrationToken?.trim();
  if (!token) {
    throw new Error("Matrix E2EE destructive QA scenarios require a registration token");
  }
  return token;
}

async function createMatrixQaDriverPersistentClient(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    deviceId: context.driverDeviceId,
    observedEvents: context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(context),
    password: context.driverPassword,
    scenarioId,
    timeoutMs: context.timeoutMs,
    userId: context.driverUserId,
  });
}

async function registerMatrixQaDestructiveOwner(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  const localpartSuffix = scenarioId
    .replace(/^matrix-e2ee-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const account = await createMatrixQaClient({ baseUrl: context.baseUrl }).registerWithToken({
    deviceName: "OpenClaw Matrix QA Destructive Owner",
    localpart: `qa-destructive-${localpartSuffix}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    password: `matrix-qa-${randomUUID()}`,
    registrationToken: requireMatrixQaRegistrationToken(context),
  });
  if (!account.deviceId) {
    throw new Error(
      `Matrix destructive QA registration for ${scenarioId} did not return a device id`,
    );
  }
  return {
    ...account,
    deviceId: account.deviceId,
  };
}

async function createMatrixQaDestructiveOwnerClient(params: {
  account: Awaited<ReturnType<typeof registerMatrixQaDestructiveOwner>>;
  context: MatrixQaScenarioContext;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: params.account.accessToken,
    actorId: `driver-destructive-${randomUUID().slice(0, 8)}`,
    baseUrl: params.context.baseUrl,
    deviceId: params.account.deviceId,
    observedEvents: params.context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    password: params.account.password,
    scenarioId: params.scenarioId,
    timeoutMs: params.context.timeoutMs,
    userId: params.account.userId,
  });
}

async function ensureMatrixQaOwnerReady(params: {
  allowCrossSigningResetOnRepair?: boolean;
  client: MatrixQaE2eeScenarioClient;
  label: string;
}) {
  let bootstrap = await params.client.bootstrapOwnDeviceVerification({
    allowAutomaticCrossSigningReset: false,
  });
  if (!bootstrap.success && isMatrixQaRepairableBackupBootstrapError(bootstrap.error)) {
    const reset = await params.client.resetRoomKeyBackup();
    if (reset.success) {
      bootstrap = await params.client.bootstrapOwnDeviceVerification({
        allowAutomaticCrossSigningReset: false,
      });
    }
  }
  if (
    !bootstrap.success &&
    params.allowCrossSigningResetOnRepair === true &&
    isMatrixQaRepairableBackupBootstrapError(bootstrap.error)
  ) {
    bootstrap = await params.client.bootstrapOwnDeviceVerification({
      forceResetCrossSigning: true,
    });
  }
  if (
    !bootstrap.success ||
    !bootstrap.verification.verified ||
    !bootstrap.verification.crossSigningVerified ||
    !bootstrap.verification.backupVersion
  ) {
    throw new Error(
      `${params.label} Matrix E2EE bootstrap did not leave identity trust and backup ready: ${
        bootstrap.error ?? "unknown error"
      }`,
    );
  }
  const recoveryKey = await params.client.getRecoveryKey();
  const encodedRecoveryKey = recoveryKey?.encodedPrivateKey?.trim();
  if (!encodedRecoveryKey) {
    throw new Error(`${params.label} Matrix E2EE bootstrap did not expose a recovery key`);
  }
  return {
    backupVersion: bootstrap.verification.backupVersion,
    encodedRecoveryKey,
    recoveryKeyId: recoveryKey?.keyId ?? null,
  };
}

function isMatrixQaRepairableBackupBootstrapError(error: string | undefined) {
  const normalized = error?.toLowerCase() ?? "";
  return (
    normalized.includes("room key backup is not usable") ||
    normalized.includes("room key backup is missing") ||
    normalized.includes("no current key backup") ||
    normalized.includes("m.megolm_backup.v1") ||
    normalized.includes("backup decryption key could not be loaded") ||
    normalized.includes("bad mac")
  );
}

async function prepareMatrixQaDestructiveSetup(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
): Promise<MatrixQaDestructiveSetup> {
  const account = await registerMatrixQaDestructiveOwner(context, scenarioId);
  const setupClient = createMatrixQaClient({
    accessToken: account.accessToken,
    baseUrl: context.baseUrl,
  });
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  const roomId = await setupClient.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [],
    name: `Matrix QA ${scenarioId}`,
  });
  const owner = await createMatrixQaDestructiveOwnerClient({ account, context, scenarioId });
  try {
    const ready = await ensureMatrixQaOwnerReady({ client: owner, label: "destructive owner" });
    const seededEventId = await owner.sendTextMessage({
      body: `E2EE destructive restore seed ${randomUUID().slice(0, 8)}`,
      roomId,
    });
    return {
      encodedRecoveryKey: ready.encodedRecoveryKey,
      owner,
      ownerAccessToken: account.accessToken,
      ownerDeviceId: account.deviceId,
      ownerPassword: account.password,
      ownerUserId: account.userId,
      recoveryKeyId: ready.recoveryKeyId,
      roomId,
      roomKey,
      seededEventId,
    };
  } catch (error) {
    await owner.stop().catch(() => undefined);
    throw error;
  }
}

async function createMatrixQaRecoveryCliRuntime(params: {
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

async function loginMatrixQaRecoveryDevice(params: {
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

async function runMatrixQaCliJson<T>(params: {
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

function assertMatrixQaCliBackupRestoreSucceeded(restore: MatrixQaCliBackupStatus, label: string) {
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

function assertMatrixQaCliBackupRestoreFailed(
  restore: MatrixQaCliBackupStatus | MatrixQaCliVerificationStatus,
  label: string,
) {
  if (restore.success === true) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
  if (!restore.error) {
    throw new Error(`${label} failed without an actionable diagnostic`);
  }
}

function isMatrixQaVerifyStatusHealthy(status: {
  payload: MatrixQaCliVerificationStatus;
  result: MatrixQaCliRunResult;
}) {
  return status.result.exitCode === 0 && status.payload.serverDeviceKnown !== false;
}

function isMatrixQaDeletedDeviceStatus(params: {
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

async function findFilesByName(params: { filename: string; rootDir: string }): Promise<string[]> {
  const matches: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 10) {
      return;
    }
    let entries: Array<{
      isDirectory(): boolean;
      isFile(): boolean;
      name: string;
    }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === params.filename) {
        matches.push(entryPath);
      } else if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
      }
    }
  }
  await visit(params.rootDir, 0);
  return matches.toSorted();
}

async function findMatrixQaCliAccountRoot(params: {
  deviceId: string;
  runtime: MatrixQaCliRuntime;
  userId: string;
}) {
  const metadataPaths = await findFilesByName({
    filename: "storage-meta.json",
    rootDir: params.runtime.stateDir,
  });
  for (const metadataPath of metadataPaths) {
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        deviceId?: unknown;
        userId?: unknown;
      };
      if (metadata.userId === params.userId && metadata.deviceId === params.deviceId) {
        return path.dirname(metadataPath);
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Matrix CLI account storage root was not created for ${params.userId}`);
}

async function mutateMatrixQaCliStateLoss(params: {
  deviceId: string;
  preserveRecoveryKey: boolean;
  runtime: MatrixQaCliRuntime;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const recoveryKeyPath = path.join(accountRoot, "recovery-key.json");
  const preservedRecoveryKeyPath = path.join(
    params.runtime.stateDir,
    "preserved-recovery-key.json",
  );
  let recoveryKeyPreserved = false;
  if (params.preserveRecoveryKey) {
    await copyFile(recoveryKeyPath, preservedRecoveryKeyPath);
    await chmod(preservedRecoveryKeyPath, 0o600).catch(() => undefined);
    recoveryKeyPreserved = true;
  }
  await rm(accountRoot, { force: true, recursive: true });
  if (params.preserveRecoveryKey) {
    await mkdir(accountRoot, { recursive: true });
    await copyFile(preservedRecoveryKeyPath, recoveryKeyPath);
  }
  return {
    accountRoot,
    recoveryKeyPreserved,
  };
}

async function corruptMatrixQaCliIdbSnapshot(params: {
  deviceId: string;
  runtime: MatrixQaCliRuntime;
  userId: string;
}) {
  const accountRoot = await findMatrixQaCliAccountRoot(params);
  const idbSnapshotPath = path.join(accountRoot, "crypto-idb-snapshot.json");
  await stat(idbSnapshotPath);
  await writeFile(idbSnapshotPath, "{ this is not valid indexeddb json\n", "utf8");
  return idbSnapshotPath;
}

async function deleteMatrixQaServerRoomKeyBackup(params: {
  accessToken: string;
  baseUrl: string;
  version: string;
}) {
  const response = await requestMatrixJson<Record<string, never>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: `/_matrix/client/v3/room_keys/version/${encodeURIComponent(params.version)}`,
    fetchImpl: fetch,
    method: "DELETE",
    okStatuses: [200, 404],
  });
  return response.status;
}

async function runMatrixQaExternalKeyRestore(params: {
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

export async function runMatrixQaE2eeStateLossExternalRecoveryKeyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-state-loss-external-recovery-key",
  );
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "external-key",
    context,
    deviceName: "OpenClaw Matrix QA External Key Restore",
    label: "state-loss-external-recovery-key",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "external-key",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-with-external-key",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(restored.payload, "external recovery-key");
    const diagnostics = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      args: ["matrix", "verify", "status", "--account", "external-key", "--json"],
      label: "status-after-external-key-restore",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    const backupKeyLoaded =
      diagnostics.payload.backup?.matchesDecryptionKey === true &&
      diagnostics.payload.backup?.decryptionKeyCached === true &&
      !diagnostics.payload.backup?.keyLoadError;
    const recoveryKeyCompletedIdentity =
      diagnostics.payload.verified === true &&
      diagnostics.payload.crossSigningVerified === true &&
      diagnostics.payload.signedByOwner === true;
    if (!backupKeyLoaded) {
      throw new Error(
        "external recovery-key scenario did not preserve backup-key restore diagnostics",
      );
    }
    return {
      artifacts: {
        recoveryDeviceId: device.deviceId,
        recoveryKeyAccepted: backupKeyLoaded,
        recoveryKeyId: setup.recoveryKeyId,
        restoreImported: restored.payload.imported,
        restoreTotal: restored.payload.total,
        selfVerificationTransactionId: null,
        seededEventId: setup.seededEventId,
        verificationExitCode: diagnostics.result.exitCode,
      },
      details: [
        "deleted Matrix state simulated with a fresh OpenClaw CLI state root",
        `encrypted room id: ${setup.roomId}`,
        `seeded encrypted event: ${setup.seededEventId}`,
        `recovery device: ${device.deviceId}`,
        `restore imported/total: ${restored.payload.imported ?? 0}/${restored.payload.total ?? 0}`,
        `recovery key accepted: ${backupKeyLoaded ? "yes" : "no"}`,
        `backup usable: ${backupKeyLoaded ? "yes" : "no"}`,
        `device owner verified before self-verification: ${
          diagnostics.payload.verified ? "yes" : "no"
        }`,
        `device owner verified after recovery flow: ${recoveryKeyCompletedIdentity ? "yes" : "no"}`,
        `restore stdout: ${restored.artifacts.stdoutPath}`,
        `verify diagnostics stdout: ${diagnostics.artifacts.stdoutPath}`,
        "verify self stdout: <not required; external recovery key proves backup access only>",
        "final status stdout: <not required>",
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeStateLossStoredRecoveryKeyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-state-loss-stored-recovery-key",
  );
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "stored-key",
    context,
    deviceName: "OpenClaw Matrix QA Stored Key Restore",
    label: "state-loss-stored-recovery-key",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const initial = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "stored-key",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "initial-restore-stores-key",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(initial.payload, "initial stored-key");
    const mutation = await mutateMatrixQaCliStateLoss({
      deviceId: device.deviceId,
      preserveRecoveryKey: true,
      runtime: cli,
      userId: device.userId,
    });
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: ["matrix", "verify", "backup", "restore", "--account", "stored-key", "--json"],
      label: "restore-from-stored-key",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(restored.payload, "stored recovery-key");
    const status = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      args: ["matrix", "verify", "status", "--account", "stored-key", "--json"],
      label: "status-after-stored-key-restore",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    if (status.payload.recoveryKeyStored !== true) {
      throw new Error("stored recovery-key restore did not keep recovery-key.json usable on disk");
    }
    return {
      artifacts: {
        accountRoot: mutation.accountRoot,
        recoveryDeviceId: device.deviceId,
        recoveryKeyPreserved: mutation.recoveryKeyPreserved,
        restoreImported: restored.payload.imported,
        restoreTotal: restored.payload.total,
        seededEventId: setup.seededEventId,
      },
      details: [
        "Matrix crypto/runtime state was deleted while recovery-key.json survived",
        `account root: ${mutation.accountRoot}`,
        `restore imported/total: ${restored.payload.imported ?? 0}/${restored.payload.total ?? 0}`,
        "restore command supplied recovery key: no",
        `recovery key stored after restore: ${status.payload.recoveryKeyStored ? "yes" : "no"}`,
        `restore stdout: ${restored.artifacts.stdoutPath}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeStateLossNoRecoveryKeyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-state-loss-no-recovery-key",
  );
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "no-key",
    context,
    deviceName: "OpenClaw Matrix QA No Key Restore",
    label: "state-loss-no-recovery-key",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      allowNonZero: true,
      args: ["matrix", "verify", "backup", "restore", "--account", "no-key", "--json"],
      label: "restore-without-key",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreFailed(restored.payload, "no recovery-key restore");
    return {
      artifacts: {
        recoveryDeviceId: device.deviceId,
        restoreError: restored.payload.error,
        restoreExitCode: restored.result.exitCode,
        seededEventId: setup.seededEventId,
      },
      details: [
        "deleted Matrix state with no recovery key failed closed",
        `restore exit code: ${restored.result.exitCode}`,
        `restore error: ${restored.payload.error}`,
        `restore stdout: ${restored.artifacts.stdoutPath}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeStaleRecoveryKeyAfterBackupResetScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-stale-recovery-key-after-backup-reset",
  );
  const rotated = await setup.owner.resetRoomKeyBackup({ rotateRecoveryKey: true });
  if (!rotated.success) {
    await setup.owner.stop().catch(() => undefined);
    throw new Error(
      `Matrix recovery-key rotation failed before stale-key check: ${rotated.error ?? "unknown"}`,
    );
  }
  const freshKey = await setup.owner.getRecoveryKey();
  const freshEncodedKey = freshKey?.encodedPrivateKey?.trim();
  if (!freshEncodedKey || freshEncodedKey === setup.encodedRecoveryKey) {
    await setup.owner.stop().catch(() => undefined);
    throw new Error("Matrix backup reset did not rotate the recovery key for stale-key coverage");
  }
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "stale-key",
    context,
    deviceName: "OpenClaw Matrix QA Stale Key Restore",
    label: "stale-recovery-key-after-backup-reset",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      allowNonZero: true,
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "stale-key",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-with-stale-key",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreFailed(restored.payload, "stale recovery-key restore");
    return {
      artifacts: {
        backupCreatedVersion: rotated.createdVersion,
        backupPreviousVersion: rotated.previousVersion,
        recoveryDeviceId: device.deviceId,
        rotatedRecoveryKeyId: freshKey?.keyId ?? null,
        restoreError: restored.payload.error,
        restoreExitCode: restored.result.exitCode,
      },
      details: [
        "old recovery key was rejected after cross-signing and backup reset",
        `previous backup version: ${rotated.previousVersion ?? "<none>"}`,
        `current backup version: ${rotated.createdVersion ?? "<none>"}`,
        `restore error: ${restored.payload.error}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeServerBackupDeletedLocalStateIntactScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-server-backup-deleted-local-state-intact",
  );
  try {
    const before = await setup.owner.restoreRoomKeyBackup({
      recoveryKey: setup.encodedRecoveryKey,
    });
    if (!before.success || !before.backupVersion) {
      throw new Error(`Matrix backup preflight restore failed: ${before.error ?? "unknown"}`);
    }
    const deleteStatus = await deleteMatrixQaServerRoomKeyBackup({
      accessToken: setup.ownerAccessToken,
      baseUrl: context.baseUrl,
      version: before.backupVersion,
    });
    const after = await setup.owner.restoreRoomKeyBackup({
      recoveryKey: setup.encodedRecoveryKey,
    });
    if (after.success) {
      throw new Error("restore unexpectedly succeeded after server room-key backup deletion");
    }
    const localEventId = await setup.owner.sendTextMessage({
      body: `E2EE local crypto still sends after backup deletion ${randomUUID().slice(0, 8)}`,
      roomId: setup.roomId,
    });
    return {
      artifacts: {
        backupDeletedHttpStatus: deleteStatus,
        deletedBackupVersion: before.backupVersion,
        localEventId,
        restoreErrorAfterDelete: after.error,
        seededEventId: setup.seededEventId,
      },
      details: [
        "server room-key backup was deleted while local crypto state stayed intact",
        `deleted backup version: ${before.backupVersion}`,
        `delete HTTP status: ${deleteStatus}`,
        `restore after delete error: ${after.error}`,
        `local encrypted send after delete: ${localEventId}`,
      ].join("\n"),
    };
  } finally {
    await setup.owner.resetRoomKeyBackup().catch(() => undefined);
    await setup.owner.stop().catch(() => undefined);
  }
}

async function waitForMatrixQaNonEmptyCliBackupRestore(params: {
  accountId: string;
  cli: MatrixQaCliRuntime;
  label: string;
  recoveryKey: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<typeof runMatrixQaCliJson<MatrixQaCliBackupStatus>>> | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingMs = params.timeoutMs - (Date.now() - startedAt);
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        params.accountId,
        "--recovery-key-stdin",
        "--json",
      ],
      label: params.label,
      runtime: params.cli,
      stdin: `${params.recoveryKey}\n`,
      timeoutMs: Math.max(1, remainingMs),
    });
    last = restored;
    assertMatrixQaCliBackupRestoreSucceeded(restored.payload, params.label);
    if ((restored.payload.total ?? 0) > 0 && (restored.payload.imported ?? 0) > 0) {
      return restored;
    }
    await sleep(500);
  }
  throw new Error(
    `Matrix E2EE CLI restore did not import uploaded room keys before timeout (last imported/total: ${last?.payload.imported ?? 0}/${last?.payload.total ?? 0})`,
  );
}

export async function runMatrixQaE2eeServerBackupDeletedLocalReuploadRestoresScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const scenarioId = "matrix-e2ee-server-backup-deleted-local-reupload-restores";
  const setup = await prepareMatrixQaDestructiveSetup(context, scenarioId);
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "backup-reupload",
    context,
    deviceName: "OpenClaw Matrix QA Backup Reupload Restore",
    label: "server-backup-deleted-local-reupload-restores",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const before = await setup.owner.restoreRoomKeyBackup({
      recoveryKey: setup.encodedRecoveryKey,
    });
    if (!before.success || !before.backupVersion) {
      throw new Error(
        `Matrix backup reupload preflight restore failed: ${before.error ?? "unknown"}`,
      );
    }
    const deleteStatus = await deleteMatrixQaServerRoomKeyBackup({
      accessToken: setup.ownerAccessToken,
      baseUrl: context.baseUrl,
      version: before.backupVersion,
    });
    const afterDelete = await setup.owner.restoreRoomKeyBackup({
      recoveryKey: setup.encodedRecoveryKey,
    });
    if (afterDelete.success) {
      throw new Error("restore unexpectedly succeeded after server room-key backup deletion");
    }
    const reset = await setup.owner.resetRoomKeyBackup();
    if (!reset.success || !reset.createdVersion) {
      throw new Error(
        `Matrix backup reset after server deletion failed: ${reset.error ?? "unknown"}`,
      );
    }
    const restored = await waitForMatrixQaNonEmptyCliBackupRestore({
      accountId: "backup-reupload",
      cli,
      label: "restore-after-server-backup-reupload",
      recoveryKey: setup.encodedRecoveryKey,
      timeoutMs: context.timeoutMs,
    });
    return {
      artifacts: {
        backupCreatedVersion: reset.createdVersion,
        backupDeletedHttpStatus: deleteStatus,
        deletedBackupVersion: before.backupVersion,
        recoveryDeviceId: device.deviceId,
        restoreErrorAfterDelete: afterDelete.error,
        restoreImported: restored.payload.imported,
        restoreTotal: restored.payload.total,
        seededEventId: setup.seededEventId,
      },
      details: [
        "server room-key backup was deleted, then recreated from intact local crypto state",
        `deleted backup version: ${before.backupVersion}`,
        `delete HTTP status: ${deleteStatus}`,
        `fresh backup version: ${reset.createdVersion}`,
        `restore after delete error: ${afterDelete.error}`,
        `fresh device restored imported/total: ${restored.payload.imported ?? 0}/${restored.payload.total ?? 0}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeCorruptCryptoIdbSnapshotScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-corrupt-crypto-idb-snapshot",
  );
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "corrupt-idb",
    context,
    deviceName: "OpenClaw Matrix QA Corrupt IDB Restore",
    label: "corrupt-crypto-idb-snapshot",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const initial = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "corrupt-idb",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "initial-restore-before-corruption",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(initial.payload, "corrupt-idb initial restore");
    const corruptedPath = await corruptMatrixQaCliIdbSnapshot({
      deviceId: device.deviceId,
      runtime: cli,
      userId: device.userId,
    });
    const repaired = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "corrupt-idb",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-after-idb-corruption",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(repaired.payload, "corrupt-idb recovery");
    return {
      artifacts: {
        corruptedPath,
        recoveryDeviceId: device.deviceId,
        restoreImported: repaired.payload.imported,
        restoreTotal: repaired.payload.total,
      },
      details: [
        "corrupted crypto-idb-snapshot.json was repaired by explicit backup restore",
        `corrupted path: ${corruptedPath}`,
        `restore imported/total: ${repaired.payload.imported ?? 0}/${repaired.payload.total ?? 0}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}

export async function runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-server-device-deleted-local-state-intact",
  );
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "deleted-device",
    context,
    deviceName: "OpenClaw Matrix QA Deleted Device",
    label: "server-device-deleted-local-state-intact",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "deleted-device",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-before-device-delete",
      runtime: cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(restored.payload, "deleted-device preflight");
    await setup.owner.deleteOwnDevices([device.deviceId]);
    const ownerDevicesAfterDelete = await setup.owner.listOwnDevices();
    await setup.owner.stop().catch(() => undefined);
    const defaultStatus = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      allowNonZero: true,
      args: ["matrix", "verify", "status", "--account", "deleted-device", "--json"],
      label: "status-after-device-delete-default",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    if (isMatrixQaVerifyStatusHealthy(defaultStatus)) {
      throw new Error("default deleted device status reported healthy local state");
    }
    const status = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      allowNonZero: true,
      args: [
        "matrix",
        "verify",
        "status",
        "--account",
        "deleted-device",
        "--allow-degraded-local-state",
        "--json",
      ],
      label: "status-after-device-delete-degraded",
      runtime: cli,
      timeoutMs: context.timeoutMs,
    });
    const ownerDeviceListContainsDeletedDevice = ownerDevicesAfterDelete.some(
      (entry) => entry.deviceId === device.deviceId,
    );
    const invalidation = isMatrixQaDeletedDeviceStatus({
      ownerDeviceListContainsDeletedDevice,
      status,
    });
    if (!invalidation.invalidated) {
      throw new Error("deleted device status did not report homeserver device invalidation");
    }
    return {
      artifacts: {
        defaultStatusError: defaultStatus.payload.error,
        defaultStatusExitCode: defaultStatus.result.exitCode,
        deletedDeviceId: device.deviceId,
        serverDeviceKnown: status.payload.serverDeviceKnown ?? null,
        statusError: status.payload.error,
        statusExitCode: status.result.exitCode,
      },
      details: [
        "server-side device deletion invalidated the surviving local credentials",
        `deleted device: ${device.deviceId}`,
        `default status exit code: ${defaultStatus.result.exitCode}`,
        `degraded status exit code: ${status.result.exitCode}`,
        invalidation.authInvalidated
          ? `status error: ${status.payload.error}`
          : `device present on server: ${invalidation.deviceMissing ? "no" : "yes"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await setup.owner.stop().catch(() => undefined);
  }
}

export async function runMatrixQaE2eeServerDeviceDeletedReloginRecoversScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-server-device-deleted-relogin-recovers",
  );
  const deleted = await runMatrixQaExternalKeyRestore({
    accountId: "deleted-device-recovery",
    context,
    deviceName: "OpenClaw Matrix QA Deleted Device Recovery Source",
    label: "server-device-deleted-relogin-source",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  let replacement: Awaited<ReturnType<typeof runMatrixQaExternalKeyRestore>> | undefined;
  try {
    const preflight = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "deleted-device-recovery",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-before-device-delete",
      runtime: deleted.cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(preflight.payload, "deleted-device recovery preflight");

    await setup.owner.deleteOwnDevices([deleted.device.deviceId]);
    const ownerDevicesAfterDelete = await setup.owner.listOwnDevices();
    await setup.owner.stop().catch(() => undefined);
    const defaultStatus = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      allowNonZero: true,
      args: ["matrix", "verify", "status", "--account", "deleted-device-recovery", "--json"],
      label: "status-after-source-device-delete",
      runtime: deleted.cli,
      timeoutMs: context.timeoutMs,
    });
    const invalidation = isMatrixQaDeletedDeviceStatus({
      ownerDeviceListContainsDeletedDevice: ownerDevicesAfterDelete.some(
        (entry) => entry.deviceId === deleted.device.deviceId,
      ),
      status: defaultStatus,
    });
    if (isMatrixQaVerifyStatusHealthy(defaultStatus) || !invalidation.invalidated) {
      throw new Error("deleted source device did not fail closed before recovery re-login");
    }

    replacement = await runMatrixQaExternalKeyRestore({
      accountId: "deleted-device-recovery-relogin",
      context,
      deviceName: "OpenClaw Matrix QA Deleted Device Recovery Relogin",
      label: "server-device-deleted-relogin-recovery",
      password: setup.ownerPassword,
      userId: setup.ownerUserId,
    });
    const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
      args: [
        "matrix",
        "verify",
        "backup",
        "restore",
        "--account",
        "deleted-device-recovery-relogin",
        "--recovery-key-stdin",
        "--json",
      ],
      label: "restore-after-relogin",
      runtime: replacement.cli,
      stdin: `${setup.encodedRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    assertMatrixQaCliBackupRestoreSucceeded(restored.payload, "deleted-device relogin recovery");
    const status = await runMatrixQaCliJson<MatrixQaCliVerificationStatus>({
      args: [
        "matrix",
        "verify",
        "status",
        "--account",
        "deleted-device-recovery-relogin",
        "--json",
      ],
      label: "status-after-relogin-restore",
      runtime: replacement.cli,
      timeoutMs: context.timeoutMs,
    });
    const backupKeyLoaded =
      status.payload.backup?.matchesDecryptionKey === true &&
      status.payload.backup?.decryptionKeyCached === true &&
      !status.payload.backup?.keyLoadError;
    if (!backupKeyLoaded) {
      throw new Error("deleted-device re-login recovery did not restore usable backup access");
    }
    return {
      artifacts: {
        defaultStatusError: defaultStatus.payload.error,
        defaultStatusExitCode: defaultStatus.result.exitCode,
        deletedDeviceId: deleted.device.deviceId,
        recoveryKeyAccepted: backupKeyLoaded,
        replacementDeviceId: replacement.device.deviceId,
        restoreImported: restored.payload.imported,
        restoreTotal: restored.payload.total,
        statusExitCode: status.result.exitCode,
      },
      details: [
        "server-side device deletion failed closed, then a replacement login restored backup access",
        `deleted device: ${deleted.device.deviceId}`,
        `replacement device: ${replacement.device.deviceId}`,
        `default deleted-device status exit code: ${defaultStatus.result.exitCode}`,
        `restore imported/total: ${restored.payload.imported ?? 0}/${restored.payload.total ?? 0}`,
        `backup usable after re-login: ${backupKeyLoaded ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await replacement?.cli.dispose().catch(() => undefined);
    await deleted.cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [
      replacement?.device.deviceId,
      deleted.device.deviceId,
    ]);
  }
}

export async function runMatrixQaE2eeSyncStateLossCryptoIntactScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.gatewayStateDir || !context.restartGatewayAfterStateMutation) {
    throw new Error("Matrix E2EE sync-state loss scenario requires gateway state restart support");
  }
  const restoreAccountId = context.sutAccountId ?? "sut";
  const configPath = requireMatrixQaGatewayConfigPath(context);
  const originalAccountConfig = await readMatrixQaGatewayMatrixAccount({
    accountId: restoreAccountId,
    configPath,
  });
  const accountId = "sync-state-loss-gateway";
  const account = await registerMatrixQaDestructiveOwner(
    context,
    "matrix-e2ee-sync-state-loss-crypto-intact",
  );
  const roomKey = `${buildMatrixQaE2eeScenarioRoomKey("matrix-e2ee-sync-state-loss-crypto-intact")}-recovery`;
  const rawDriver = createMatrixQaDriverScenarioClient(context);
  const roomId = await rawDriver.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [context.observerUserId, account.userId],
    name: "Matrix QA E2EE Sync State Loss Recovery Room",
  });
  await Promise.all([
    createMatrixQaClient({
      accessToken: context.observerAccessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
    createMatrixQaClient({
      accessToken: account.accessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
  ]);
  const accountConfig: Record<string, unknown> = {
    ...originalAccountConfig,
    accessToken: account.accessToken,
    deviceId: account.deviceId,
    enabled: true,
    encryption: true,
    groups: {
      [roomId]: {
        enabled: true,
        requireMention: true,
      },
    },
    homeserver: context.baseUrl,
    password: account.password,
    startupVerification: "off",
    userId: account.userId,
  };
  let driver: MatrixQaE2eeScenarioClient | undefined;
  let gatewayAccountReplaced = false;
  try {
    await context.restartGatewayAfterStateMutation(
      async () => {
        await replaceMatrixQaGatewayMatrixAccount({
          accountConfig,
          accountId,
          configPath,
        });
        gatewayAccountReplaced = true;
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
    const syncStore = await waitForMatrixSyncStoreWithCursor({
      accountId,
      context,
      stateDir: context.gatewayStateDir,
      timeoutMs: context.timeoutMs,
      userId: account.userId,
    });
    await context.restartGatewayAfterStateMutation(
      async () => {
        await rm(syncStore.pathname, { force: true });
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
    await context.waitGatewayAccountReady?.(accountId, {
      timeoutMs: context.timeoutMs,
    });
    driver = await createMatrixQaDriverPersistentClient(
      context,
      "matrix-e2ee-sync-state-loss-crypto-intact",
    );
    const token = buildMatrixQaToken("MATRIX_QA_E2EE_SYNC_LOSS");
    const driverStartSince = await driver.prime();
    const rawStartSince = await rawDriver.primeRoom();
    const driverEventId = await driver.sendTextMessage({
      body: buildMentionPrompt(account.userId, token),
      mentionUserIds: [account.userId],
      roomId,
    });
    const decrypted = await driver.waitForRoomEvent({
      predicate: (event) =>
        isMatrixQaExactMarkerReply(event, {
          roomId,
          sutUserId: account.userId,
          token,
        }),
      roomId,
      timeoutMs: context.timeoutMs,
    });
    const reply = buildMatrixReplyArtifact(decrypted.event, token);
    assertTopLevelReplyArtifact("sync-state loss E2EE reply", reply);
    const encrypted = await rawDriver.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === roomId &&
        event.sender === account.userId &&
        event.type === "m.room.encrypted",
      roomId,
      since: rawStartSince,
      timeoutMs: context.timeoutMs,
    });
    return {
      artifacts: {
        deletedSyncStorePath: syncStore.pathname,
        driverEventId,
        reply,
        replyEventId: reply.eventId,
        roomKey,
      },
      details: [
        "gateway sync cursor was deleted while Matrix crypto state stayed intact",
        `deleted sync store: ${syncStore.pathname}`,
        `driver event: ${driverEventId}`,
        `driver E2EE cursor: ${driverStartSince}`,
        `encrypted SUT reply event: ${encrypted.event.eventId}`,
        ...buildMatrixReplyDetails("decrypted SUT reply", reply),
      ].join("\n"),
    };
  } finally {
    await driver?.stop().catch(() => undefined);
    if (gatewayAccountReplaced) {
      await context
        .restartGatewayAfterStateMutation(
          async () => {
            await replaceMatrixQaGatewayMatrixAccount({
              accountConfig: originalAccountConfig,
              accountId: restoreAccountId,
              configPath,
            });
          },
          {
            timeoutMs: context.timeoutMs,
            waitAccountId: restoreAccountId,
          },
        )
        .catch(() => undefined);
    }
  }
}

export async function runMatrixQaE2eeWrongAccountRecoveryKeyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const observerPassword = requireMatrixQaPassword(context, "observer");
  const driverSetup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-wrong-account-recovery-key",
  );
  const observer = await createMatrixQaE2eeScenarioClient({
    accessToken: context.observerAccessToken,
    actorId: `driver-destructive-${randomUUID().slice(0, 8)}`,
    baseUrl: context.baseUrl,
    deviceId: context.observerDeviceId,
    observedEvents: context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(context),
    password: context.observerPassword,
    scenarioId: "matrix-e2ee-wrong-account-recovery-key",
    timeoutMs: context.timeoutMs,
    userId: context.observerUserId,
  });
  try {
    await ensureMatrixQaOwnerReady({
      allowCrossSigningResetOnRepair: true,
      client: observer,
      label: "observer",
    });
    let device: Awaited<ReturnType<typeof loginMatrixQaRecoveryDevice>> | undefined;
    let cli: Awaited<ReturnType<typeof createMatrixQaRecoveryCliRuntime>> | undefined;
    try {
      device = await loginMatrixQaRecoveryDevice({
        context,
        deviceName: "OpenClaw Matrix QA Wrong Account Key",
        password: observerPassword,
        userId: context.observerUserId,
      });
      cli = await createMatrixQaRecoveryCliRuntime({
        accountId: "wrong-account",
        accessToken: device.accessToken,
        context,
        deviceId: device.deviceId,
        label: "wrong-account-recovery-key",
        userId: device.userId,
      });
      const restored = await runMatrixQaCliJson<MatrixQaCliBackupStatus>({
        allowNonZero: true,
        args: [
          "matrix",
          "verify",
          "backup",
          "restore",
          "--account",
          "wrong-account",
          "--recovery-key-stdin",
          "--json",
        ],
        label: "restore-with-wrong-account-key",
        runtime: cli,
        stdin: `${driverSetup.encodedRecoveryKey}\n`,
        timeoutMs: context.timeoutMs,
      });
      assertMatrixQaCliBackupRestoreFailed(restored.payload, "wrong-account recovery-key restore");
      return {
        artifacts: {
          observerRecoveryDeviceId: device.deviceId,
          restoreError: restored.payload.error,
          restoreExitCode: restored.result.exitCode,
        },
        details: [
          "driver recovery key was rejected for observer account backup",
          `restore exit code: ${restored.result.exitCode}`,
          `restore error: ${restored.payload.error}`,
        ].join("\n"),
      };
    } finally {
      await cli?.dispose().catch(() => undefined);
      await observer.stop().catch(() => undefined);
      if (device) {
        await observer.deleteOwnDevices([device.deviceId]).catch(() => undefined);
      }
    }
  } finally {
    await observer.stop().catch(() => undefined);
    await driverSetup.owner.stop().catch(() => undefined);
  }
}

export async function runMatrixQaE2eeHistoryExistsBackupEmptyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const setup = await prepareMatrixQaDestructiveSetup(
    context,
    "matrix-e2ee-history-exists-backup-empty",
  );
  const reset = await setup.owner.resetRoomKeyBackup();
  if (!reset.success) {
    await setup.owner.stop().catch(() => undefined);
    throw new Error(`Matrix empty-backup reset failed: ${reset.error ?? "unknown"}`);
  }
  const freshKey = await setup.owner.getRecoveryKey();
  const freshEncodedKey = freshKey?.encodedPrivateKey?.trim();
  if (!freshEncodedKey) {
    await setup.owner.stop().catch(() => undefined);
    throw new Error("Matrix empty-backup reset did not expose a fresh recovery key");
  }
  const { cli, device } = await runMatrixQaExternalKeyRestore({
    accountId: "empty-backup",
    context,
    deviceName: "OpenClaw Matrix QA Empty Backup",
    label: "history-exists-backup-empty",
    password: setup.ownerPassword,
    userId: setup.ownerUserId,
  });
  try {
    const restored = await waitForMatrixQaNonEmptyCliBackupRestore({
      accountId: "empty-backup",
      cli,
      label: "restore-reset-backup",
      recoveryKey: freshEncodedKey,
      timeoutMs: context.timeoutMs,
    });
    return {
      artifacts: {
        backupCreatedVersion: reset.createdVersion,
        historyEventId: setup.seededEventId,
        recoveryDeviceId: device.deviceId,
        restoreImported: restored.payload.imported,
        restoreTotal: restored.payload.total,
      },
      details: [
        "encrypted history survived a server backup reset through local key re-upload",
        `history event: ${setup.seededEventId}`,
        `reset backup version: ${reset.createdVersion ?? "<none>"}`,
        `restore imported/total: ${restored.payload.imported ?? 0}/${restored.payload.total ?? 0}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose().catch(() => undefined);
    await cleanupMatrixQaTempDevices(setup.owner, [device.deviceId]);
  }
}
