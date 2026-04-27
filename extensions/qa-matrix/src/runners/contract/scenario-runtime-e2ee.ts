import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createMatrixQaClient } from "../../substrate/client.js";
import {
  createMatrixQaE2eeScenarioClient,
  runMatrixQaE2eeBootstrap,
} from "../../substrate/e2ee-client.js";
import type { MatrixQaE2eeScenarioClient } from "../../substrate/e2ee-client.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  startMatrixQaFaultProxy,
  type MatrixQaFaultProxyHit,
  type MatrixQaFaultProxyRule,
} from "../../substrate/fault-proxy.js";
import {
  buildMatrixQaE2eeScenarioRoomKey,
  type MatrixQaE2eeScenarioId,
  MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-catalog.js";
import {
  buildMatrixQaImageUnderstandingPrompt,
  createMatrixQaSplitColorImagePng,
  hasMatrixQaExpectedColorReply,
  MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
} from "./scenario-media-fixtures.js";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
  type MatrixQaCliSession,
  type MatrixQaCliRunResult,
} from "./scenario-runtime-cli.js";
import {
  isMatrixQaPlainRecord,
  patchMatrixQaGatewayMatrixAccount,
  readMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount,
} from "./scenario-runtime-config.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  buildMatrixQaToken,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  doesMatrixQaReplyBodyMatchToken,
  isMatrixQaExactMarkerReply,
  resolveMatrixQaNoReplyWindowMs,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaReplyArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

const MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT = "/_matrix/client/v3/room_keys/version";
const MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID = "room-key-backup-version-unavailable";
const MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID = "owner-signature-upload-blocked";
const MATRIX_QA_KEYS_SIGNATURES_UPLOAD_ENDPOINT = "/_matrix/client/v3/keys/signatures/upload";

type MatrixQaE2eeBootstrapResult = Awaited<ReturnType<typeof runMatrixQaE2eeBootstrap>>;
type MatrixQaCliVerificationStatus = {
  backup?: {
    decryptionKeyCached?: boolean | null;
    keyLoadError?: string | null;
    matchesDecryptionKey?: boolean | null;
    trusted?: boolean | null;
  };
  backupVersion?: string | null;
  crossSigningVerified?: boolean;
  verified?: boolean;
  signedByOwner?: boolean;
  deviceId?: string | null;
  userId?: string | null;
};
type MatrixQaCliEncryptionSetupStatus = {
  accountId?: string;
  bootstrap?: {
    error?: string;
    success?: boolean;
  };
  configPath?: string;
  encryptionChanged?: boolean;
  status?: MatrixQaCliVerificationStatus;
  success?: boolean;
};
type MatrixQaCliAccountAddStatus = {
  accountId?: string;
  configPath?: string;
  encryptionEnabled?: boolean;
  verificationBootstrap?: {
    attempted?: boolean;
    backupVersion?: string | null;
    error?: string;
    success?: boolean;
  };
};
type MatrixQaCliBackupRestoreStatus = {
  success?: boolean;
  backup?: MatrixQaCliVerificationStatus["backup"];
  error?: string;
};

function isMatrixQaCliBackupUsable(
  backup: MatrixQaCliVerificationStatus["backup"],
  opts: { allowUntrustedMatchingKey?: boolean } = {},
): boolean {
  return Boolean(
    (backup?.trusted || opts.allowUntrustedMatchingKey === true) &&
    backup?.matchesDecryptionKey &&
    backup.decryptionKeyCached &&
    !backup.keyLoadError,
  );
}

function requireMatrixQaE2eeOutputDir(context: MatrixQaScenarioContext) {
  if (!context.outputDir) {
    throw new Error("Matrix E2EE QA scenarios require an output directory");
  }
  return context.outputDir;
}

function requireMatrixQaCliRuntimeEnv(context: MatrixQaScenarioContext) {
  if (!context.gatewayRuntimeEnv) {
    throw new Error("Matrix CLI QA scenarios require the gateway runtime environment");
  }
  return context.gatewayRuntimeEnv;
}

function requireMatrixQaGatewayConfigPath(context: MatrixQaScenarioContext) {
  const configPath = requireMatrixQaCliRuntimeEnv(context).OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    throw new Error("Matrix CLI QA scenarios require the gateway config path");
  }
  return configPath;
}

function requireMatrixQaRegistrationToken(context: MatrixQaScenarioContext) {
  const token = context.registrationToken?.trim();
  if (!token) {
    throw new Error("Matrix CLI QA scenarios require the homeserver registration token");
  }
  return token;
}

function requireMatrixQaPassword(
  context: MatrixQaScenarioContext,
  actor: "driver" | "observer" | "sut",
) {
  const password =
    actor === "driver"
      ? context.driverPassword
      : actor === "observer"
        ? context.observerPassword
        : context.sutPassword;
  if (!password) {
    throw new Error(`Matrix E2EE ${actor} password is required for this scenario`);
  }
  return password;
}

function resolveMatrixQaE2eeScenarioGroupRoom(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  return {
    roomKey,
    roomId: resolveMatrixQaScenarioRoomId(context, roomKey),
  };
}

function assertMatrixQaBootstrapSucceeded(label: string, result: MatrixQaE2eeBootstrapResult) {
  if (!result.success) {
    throw new Error(`${label} bootstrap failed: ${result.error ?? "unknown error"}`);
  }
  if (!result.verification.verified || !result.verification.signedByOwner) {
    throw new Error(`${label} bootstrap did not leave the device verified by its owner`);
  }
  if (!result.verification.crossSigningVerified) {
    throw new Error(`${label} bootstrap did not establish full Matrix identity trust`);
  }
  if (!result.crossSigning.published) {
    throw new Error(`${label} bootstrap did not publish cross-signing keys`);
  }
  if (!result.verification.recoveryKeyStored) {
    throw new Error(`${label} bootstrap did not store a recovery key`);
  }
  if (!result.verification.backupVersion) {
    throw new Error(`${label} bootstrap did not create a room-key backup`);
  }
}

function isMatrixQaRepairableBackupBootstrapError(error: string | undefined) {
  const normalized = error?.toLowerCase() ?? "";
  return (
    normalized.includes("room key backup is not usable") ||
    normalized.includes("m.megolm_backup.v1") ||
    normalized.includes("backup decryption key could not be loaded")
  );
}

const MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS = {
  allowAutomaticCrossSigningReset: false,
} as const;

async function assertMatrixQaPeerDeviceTrusted(params: {
  client: MatrixQaE2eeScenarioClient;
  deviceId: string;
  label: string;
  userId: string;
}) {
  const status = await params.client.getDeviceVerificationStatus(params.userId, params.deviceId);
  if (!status.verified) {
    throw new Error(
      `${params.label} did not trust ${params.userId}/${params.deviceId} after verification`,
    );
  }
  return status;
}

async function ensureMatrixQaE2eeOwnDeviceVerified(params: {
  client: MatrixQaE2eeScenarioClient;
  label: string;
}) {
  let bootstrap = await params.client.bootstrapOwnDeviceVerification(
    MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS,
  );
  if (!bootstrap.success && isMatrixQaRepairableBackupBootstrapError(bootstrap.error)) {
    const reset = await params.client.resetRoomKeyBackup();
    if (reset.success) {
      bootstrap = await params.client.bootstrapOwnDeviceVerification(
        MATRIX_QA_PRESERVE_IDENTITY_BOOTSTRAP_OPTIONS,
      );
    }
  }
  assertMatrixQaBootstrapSucceeded(params.label, bootstrap);
  return {
    bootstrap,
    recoveryKey: await params.client.getRecoveryKey(),
    verification: bootstrap.verification,
  };
}

async function waitForMatrixQaNonEmptyRoomKeyRestore(params: {
  client: MatrixQaE2eeScenarioClient;
  recoveryKey: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  let last: Awaited<ReturnType<MatrixQaE2eeScenarioClient["restoreRoomKeyBackup"]>> | null = null;
  while (Date.now() - startedAt < params.timeoutMs) {
    const restored = await params.client.restoreRoomKeyBackup({
      recoveryKey: params.recoveryKey,
    });
    last = restored;
    if (!restored.success) {
      throw new Error(
        `Matrix E2EE room-key backup restore failed: ${restored.error ?? "unknown error"}`,
      );
    }
    if (restored.total > 0 && restored.imported > 0) {
      return restored;
    }
    await sleep(500);
  }
  throw new Error(
    `Matrix E2EE room-key backup restore did not import any keys before timeout (last imported/total: ${last?.imported ?? 0}/${last?.total ?? 0})`,
  );
}

async function waitForMatrixQaVerificationSummary(params: {
  client: MatrixQaE2eeScenarioClient;
  label: string;
  predicate: (summary: MatrixVerificationSummary) => boolean;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const summaries = await params.client.listVerifications();
    const found = summaries.find(params.predicate);
    if (found) {
      return found;
    }
    await sleep(Math.min(250, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(`timed out waiting for Matrix verification summary: ${params.label}`);
}

function sameMatrixQaVerificationTransaction(
  left: MatrixVerificationSummary,
  right: MatrixVerificationSummary,
) {
  return Boolean(left.transactionId && left.transactionId === right.transactionId);
}

function formatMatrixQaSasEmoji(summary: MatrixVerificationSummary) {
  return summary.sas?.emoji?.map(([emoji, label]) => `${emoji} ${label}`) ?? [];
}

function parseMatrixQaCliJsonText(text: string): unknown {
  const candidate = text.trim();
  if (!candidate) {
    throw new Error("no JSON payload found");
  }
  return JSON.parse(candidate) as unknown;
}

function parseMatrixQaCliJson(result: MatrixQaCliRunResult): unknown {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) {
    try {
      return parseMatrixQaCliJsonText(stdout);
    } catch (error) {
      throw new Error(
        `${formatMatrixQaCliCommand(result.args)} printed invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }\nstdout:\n${redactMatrixQaCliOutput(stdout)}`,
        { cause: error },
      );
    }
  }

  if (!stderr) {
    throw new Error(`${formatMatrixQaCliCommand(result.args)} did not print JSON`);
  }
  try {
    return parseMatrixQaCliJsonText(stderr);
  } catch (error) {
    throw new Error(
      `${formatMatrixQaCliCommand(result.args)} printed invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\nstderr:\n${redactMatrixQaCliOutput(stderr)}`,
      { cause: error },
    );
  }
}

function buildMatrixQaPluginActivationConfig() {
  return {
    plugins: {
      allow: ["matrix"],
      entries: {
        matrix: { enabled: true },
      },
    },
  };
}

function buildMatrixQaEmptyMatrixCliConfig() {
  return {
    ...buildMatrixQaPluginActivationConfig(),
    channels: {
      matrix: {
        enabled: true,
        accounts: {},
      },
    },
  };
}

async function registerMatrixQaCliE2eeAccount(params: {
  context: MatrixQaScenarioContext;
  deviceName: string;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  const localpartSuffix = params.scenarioId
    .replace(/^matrix-e2ee-cli-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const account = await createMatrixQaClient({
    baseUrl: params.context.baseUrl,
  }).registerWithToken({
    deviceName: params.deviceName,
    localpart: `qa-cli-${localpartSuffix}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    password: `matrix-qa-${randomUUID()}`,
    registrationToken: requireMatrixQaRegistrationToken(params.context),
  });
  if (!account.deviceId) {
    throw new Error(
      `Matrix CLI QA registration for ${params.scenarioId} did not return a device id`,
    );
  }
  return account;
}

async function registerMatrixQaE2eeScenarioAccount(params: {
  context: MatrixQaScenarioContext;
  deviceName: string;
  localpartPrefix: string;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  const localpartSuffix = params.scenarioId
    .replace(/^matrix-e2ee-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const account = await createMatrixQaClient({
    baseUrl: params.context.baseUrl,
  }).registerWithToken({
    deviceName: params.deviceName,
    localpart: `${params.localpartPrefix}-${localpartSuffix}-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    password: `matrix-qa-${randomUUID()}`,
    registrationToken: requireMatrixQaRegistrationToken(params.context),
  });
  if (!account.deviceId) {
    throw new Error(
      `Matrix E2EE QA registration for ${params.scenarioId} did not return a device id`,
    );
  }
  return account;
}

async function createMatrixQaE2eeCliOwnerClient(params: {
  account: Awaited<ReturnType<typeof registerMatrixQaCliE2eeAccount>>;
  context: MatrixQaScenarioContext;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: params.account.accessToken,
    actorId: `cli-owner-${randomUUID().slice(0, 8)}`,
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

function parseMatrixQaCliSasText(
  text: string,
  label: string,
): { kind: "emoji"; value: string } | { kind: "decimal"; value: string } {
  const emoji = text.match(/^SAS emoji:\s*(.+)$/m)?.[1]?.trim();
  if (emoji) {
    return { kind: "emoji", value: emoji };
  }
  const decimal = text.match(/^SAS decimals:\s*(.+)$/m)?.[1]?.trim();
  if (decimal) {
    return { kind: "decimal", value: decimal };
  }
  throw new Error(`${label} did not print SAS emoji or decimals`);
}

function parseMatrixQaCliSummaryField(text: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
}

async function writeMatrixQaCliOutputArtifacts(params: {
  label: string;
  result: MatrixQaCliRunResult;
  rootDir: string;
}) {
  await mkdir(params.rootDir, { mode: 0o700, recursive: true });
  await chmod(params.rootDir, 0o700).catch(() => undefined);
  const prefix = params.label.replace(/[^A-Za-z0-9_-]/g, "-");
  const stdoutPath = path.join(params.rootDir, `${prefix}.stdout.txt`);
  const stderrPath = path.join(params.rootDir, `${prefix}.stderr.txt`);
  await Promise.all([
    writeFile(stdoutPath, redactMatrixQaCliOutput(params.result.stdout), { mode: 0o600 }),
    writeFile(stderrPath, redactMatrixQaCliOutput(params.result.stderr), { mode: 0o600 }),
  ]);
  return { stderrPath, stdoutPath };
}

async function assertMatrixQaPrivatePathMode(pathToCheck: string, label: string) {
  if (process.platform === "win32") {
    return;
  }
  const mode = (await stat(pathToCheck)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad: ${mode.toString(8)}`);
  }
}

function assertMatrixQaCliSasMatches(params: {
  cliSas: ReturnType<typeof parseMatrixQaCliSasText>;
  owner: MatrixVerificationSummary;
}) {
  if (params.cliSas.kind === "emoji") {
    const ownerEmoji = formatMatrixQaSasEmoji(params.owner).join(" | ");
    if (!ownerEmoji) {
      throw new Error("Matrix owner client did not expose SAS emoji");
    }
    if (params.cliSas.value !== ownerEmoji) {
      throw new Error("Matrix CLI SAS emoji did not match the owner client");
    }
    return ownerEmoji.split(" | ");
  }

  const ownerDecimal = params.owner.sas?.decimal?.join(" ");
  if (!ownerDecimal) {
    throw new Error("Matrix owner client did not expose SAS decimals");
  }
  if (params.cliSas.value !== ownerDecimal) {
    throw new Error("Matrix CLI SAS decimals did not match the owner client");
  }
  return [ownerDecimal];
}

function isMatrixQaCliOwnerSelfVerification(params: {
  cliDeviceId?: string;
  ownerUserId: string;
  requireCompleted?: boolean;
  requirePending?: boolean;
  requireSas?: boolean;
  summary: MatrixVerificationSummary;
  transactionId?: string;
}) {
  const summary = params.summary;
  if (
    !summary.isSelfVerification ||
    summary.initiatedByMe ||
    summary.otherUserId !== params.ownerUserId
  ) {
    return false;
  }
  if (params.transactionId) {
    if (summary.transactionId !== params.transactionId) {
      return false;
    }
  } else if (params.cliDeviceId && summary.otherDeviceId !== params.cliDeviceId) {
    return false;
  }
  if (params.requirePending === true && !summary.pending) {
    return false;
  }
  if (params.requireSas === true && !summary.hasSas) {
    return false;
  }
  return params.requireCompleted !== true || summary.completed;
}

async function createMatrixQaCliSelfVerificationRuntime(params: {
  accountId: string;
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  userId: string;
}) {
  const outputDir = requireMatrixQaE2eeOutputDir(params.context);
  const rootDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-cli-qa-"),
  );
  const artifactDir = path.join(
    outputDir,
    "cli-self-verification",
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  const stateDir = path.join(rootDir, "state");
  const configPath = path.join(rootDir, "config.json");
  await chmod(rootDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(rootDir, "Matrix QA CLI temp directory");
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await chmod(stateDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(stateDir, "Matrix QA CLI state directory");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        plugins: {
          allow: ["matrix"],
          entries: {
            matrix: { enabled: true },
          },
        },
        channels: {
          matrix: {
            defaultAccount: params.accountId,
            accounts: {
              [params.accountId]: {
                accessToken: params.accessToken,
                deviceId: params.deviceId,
                encryption: true,
                homeserver: params.context.baseUrl,
                initialSyncLimit: 0,
                name: "Matrix QA CLI self-verification",
                network: {
                  dangerouslyAllowPrivateNetwork: true,
                },
                startupVerification: "off",
                userId: params.userId,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await assertMatrixQaPrivatePathMode(configPath, "Matrix QA CLI config file");
  const env = {
    ...requireMatrixQaCliRuntimeEnv(params.context),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_AUTO_UPDATE: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const run = async (args: string[], timeoutMs = params.context.timeoutMs, stdin?: string) =>
    await runMatrixQaOpenClawCli({
      args,
      env,
      stdin,
      timeoutMs,
    });
  const start = (args: string[], timeoutMs = params.context.timeoutMs) =>
    startMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  return {
    configPath,
    dispose: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    run,
    rootDir: artifactDir,
    start,
    stateDir,
  };
}

async function createMatrixQaCliE2eeSetupRuntime(params: {
  artifactLabel: string;
  context: MatrixQaScenarioContext;
  initialConfig?: Record<string, unknown>;
}) {
  const outputDir = requireMatrixQaE2eeOutputDir(params.context);
  const rootDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-e2ee-setup-qa-"),
  );
  const artifactDir = path.join(
    outputDir,
    params.artifactLabel,
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  const stateDir = path.join(rootDir, "state");
  const configPath = path.join(rootDir, "config.json");
  await chmod(rootDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(rootDir, "Matrix QA CLI temp directory");
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  await chmod(stateDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(stateDir, "Matrix QA CLI state directory");
  await writeFile(
    configPath,
    `${JSON.stringify(params.initialConfig ?? buildMatrixQaEmptyMatrixCliConfig(), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await assertMatrixQaPrivatePathMode(configPath, "Matrix QA CLI config file");
  const env = {
    ...requireMatrixQaCliRuntimeEnv(params.context),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_AUTO_UPDATE: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const run = async (args: string[], timeoutMs = params.context.timeoutMs) =>
    await runMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  const start = (args: string[], timeoutMs = params.context.timeoutMs) =>
    startMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  return {
    configPath,
    dispose: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    run,
    rootDir: artifactDir,
    start,
    stateDir,
  };
}

async function createMatrixQaCliGatewayRuntime(params: {
  artifactLabel: string;
  context: MatrixQaScenarioContext;
}) {
  const outputDir = requireMatrixQaE2eeOutputDir(params.context);
  const rootDir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-gateway-cli-qa-"),
  );
  const artifactDir = path.join(
    outputDir,
    params.artifactLabel,
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  const pluginStageDir = path.join(rootDir, "plugin-stage");
  await chmod(rootDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(rootDir, "Matrix QA CLI temp directory");
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  await mkdir(pluginStageDir, { mode: 0o700, recursive: true });
  await chmod(pluginStageDir, 0o700).catch(() => undefined);
  const env = {
    ...requireMatrixQaCliRuntimeEnv(params.context),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_DISABLE_AUTO_UPDATE: "1",
    OPENCLAW_PLUGIN_STAGE_DIR: pluginStageDir,
  };
  const run = async (args: string[], timeoutMs = params.context.timeoutMs) =>
    await runMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  return {
    dispose: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    rootDir: artifactDir,
    run,
  };
}

function assertMatrixQaSasEmojiMatches(params: {
  initiator: MatrixVerificationSummary;
  recipient: MatrixVerificationSummary;
}) {
  const initiatorEmoji = formatMatrixQaSasEmoji(params.initiator);
  const recipientEmoji = formatMatrixQaSasEmoji(params.recipient);
  if (initiatorEmoji.length === 0 || recipientEmoji.length === 0) {
    throw new Error("Matrix SAS verification did not expose emoji data on both devices");
  }
  if (JSON.stringify(initiatorEmoji) !== JSON.stringify(recipientEmoji)) {
    throw new Error("Matrix SAS emoji did not match between verification devices");
  }
  return initiatorEmoji;
}

function isMatrixQaE2eeNoticeTriggeredSutReply(params: {
  event: MatrixQaObservedEvent;
  noticeEventId: string;
  noticeSentAt: number;
  roomId: string;
  sutUserId: string;
  token: string;
}) {
  if (
    params.event.roomId !== params.roomId ||
    params.event.sender !== params.sutUserId ||
    params.event.type !== "m.room.message"
  ) {
    return false;
  }
  if (params.event.body?.includes(params.token)) {
    return true;
  }
  if (
    params.event.relatesTo?.eventId === params.noticeEventId ||
    params.event.relatesTo?.inReplyToId === params.noticeEventId
  ) {
    return true;
  }
  return (
    typeof params.event.originServerTs === "number" &&
    params.event.originServerTs >= params.noticeSentAt
  );
}

async function createMatrixQaE2eeDriverClient(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  opts: { actorId?: "driver" | `driver-${string}` } = {},
) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: context.driverAccessToken,
    actorId: opts.actorId ?? "driver",
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

async function createMatrixQaE2eeObserverClient(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    baseUrl: context.baseUrl,
    deviceId: context.observerDeviceId,
    observedEvents: context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(context),
    password: context.observerPassword,
    scenarioId,
    timeoutMs: context.timeoutMs,
    userId: context.observerUserId,
  });
}

async function withMatrixQaE2eeDriverAndObserver<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (clients: {
    driver: MatrixQaE2eeScenarioClient;
    observer: MatrixQaE2eeScenarioClient;
  }) => Promise<T>,
) {
  const driver = await createMatrixQaE2eeDriverClient(context, scenarioId);
  const observer = await createMatrixQaE2eeObserverClient(context, scenarioId);
  try {
    return await run({ driver, observer });
  } finally {
    await Promise.all([driver.stop(), observer.stop()]);
  }
}

async function completeMatrixQaSasVerification(params: {
  initiator: MatrixQaE2eeScenarioClient;
  recipient: MatrixQaE2eeScenarioClient;
  recipientUserId: string;
  request: {
    deviceId?: string;
    roomId?: string;
    userId: string;
  };
  timeoutMs: number;
}) {
  const initiated = await params.initiator.requestVerification(params.request);
  const recipientRequested = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient request",
    predicate: (summary) =>
      !summary.initiatedByMe &&
      (sameMatrixQaVerificationTransaction(summary, initiated) ||
        (summary.otherUserId !== params.recipientUserId && summary.pending)),
    timeoutMs: params.timeoutMs,
  });
  if (recipientRequested.canAccept) {
    await params.recipient.acceptVerification(recipientRequested.id);
  }
  await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator ready",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.phaseName === "ready",
    timeoutMs: params.timeoutMs,
  });
  await params.initiator.startVerification(initiated.id, "sas");
  const initiatorSas = await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator SAS",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.hasSas,
    timeoutMs: params.timeoutMs,
  });
  const recipientSas = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient SAS",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiatorSas) && summary.hasSas,
    timeoutMs: params.timeoutMs,
  });
  const sasEmoji = assertMatrixQaSasEmojiMatches({
    initiator: initiatorSas,
    recipient: recipientSas,
  });
  await params.initiator.confirmVerificationSas(initiatorSas.id);
  await params.recipient.confirmVerificationSas(recipientSas.id);
  const completedInitiator = await waitForMatrixQaVerificationSummary({
    client: params.initiator,
    label: "initiator complete",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, initiated) && summary.completed,
    timeoutMs: params.timeoutMs,
  });
  const completedRecipient = await waitForMatrixQaVerificationSummary({
    client: params.recipient,
    label: "recipient complete",
    predicate: (summary) =>
      sameMatrixQaVerificationTransaction(summary, completedInitiator) && summary.completed,
    timeoutMs: params.timeoutMs,
  });
  return {
    completedInitiator,
    completedRecipient,
    sasEmoji,
  };
}

function buildMatrixE2eeReplyArtifact(
  event: MatrixQaObservedEvent,
  token: string,
): MatrixQaReplyArtifact {
  return {
    eventId: event.eventId,
    mentions: event.mentions,
    relatesTo: event.relatesTo,
    sender: event.sender,
    tokenMatched: doesMatrixQaReplyBodyMatchToken(event, token),
  };
}

function buildRoomKeyBackupUnavailableFaultRule(accessToken: string): MatrixQaFaultProxyRule {
  return {
    id: MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
    match: (request) =>
      request.method === "GET" &&
      request.path === MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT &&
      request.bearerToken === accessToken,
    response: () => ({
      body: {
        errcode: "M_NOT_FOUND",
        error: "No current key backup",
      },
      status: 404,
    }),
  };
}

function buildOwnerSignatureUploadBlockedFaultRule(accessToken: string): MatrixQaFaultProxyRule {
  return {
    id: MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
    match: (request) =>
      request.method === "POST" &&
      request.path === MATRIX_QA_KEYS_SIGNATURES_UPLOAD_ENDPOINT &&
      request.bearerToken === accessToken,
    response: () => ({
      body: {},
      status: 200,
    }),
  };
}

async function runMatrixQaFaultedE2eeBootstrap(context: MatrixQaScenarioContext): Promise<{
  faultHits: MatrixQaFaultProxyHit[];
  result: MatrixQaE2eeBootstrapResult;
}> {
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.baseUrl,
    rules: [buildRoomKeyBackupUnavailableFaultRule(context.driverAccessToken)],
  });
  try {
    const result = await runMatrixQaE2eeBootstrap({
      accessToken: context.driverAccessToken,
      actorId: "driver",
      baseUrl: proxy.baseUrl,
      deviceId: context.driverDeviceId,
      outputDir: requireMatrixQaE2eeOutputDir(context),
      ...(context.driverPassword ? { password: context.driverPassword } : {}),
      scenarioId: "matrix-e2ee-key-bootstrap-failure",
      timeoutMs: context.timeoutMs,
      userId: context.driverUserId,
    });
    return {
      faultHits: proxy.hits(),
      result,
    };
  } finally {
    await proxy.stop();
  }
}

async function runMatrixQaFaultedRecoveryOwnerVerification(params: {
  accessToken: string;
  context: MatrixQaScenarioContext;
  deviceId: string;
  encodedRecoveryKey: string;
  userId: string;
}): Promise<{
  faultHits: MatrixQaFaultProxyHit[];
  restore: Awaited<ReturnType<MatrixQaE2eeScenarioClient["restoreRoomKeyBackup"]>>;
  verification: Awaited<ReturnType<MatrixQaE2eeScenarioClient["verifyWithRecoveryKey"]>>;
}> {
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: params.context.baseUrl,
    rules: [buildOwnerSignatureUploadBlockedFaultRule(params.accessToken)],
  });
  const recoveryClient = await createMatrixQaE2eeScenarioClient({
    accessToken: params.accessToken,
    actorId: `driver-recovery-${randomUUID().slice(0, 8)}`,
    baseUrl: proxy.baseUrl,
    deviceId: params.deviceId,
    observedEvents: params.context.observedEvents,
    outputDir: requireMatrixQaE2eeOutputDir(params.context),
    scenarioId: "matrix-e2ee-recovery-owner-verification-required",
    timeoutMs: params.context.timeoutMs,
    userId: params.userId,
  });
  try {
    const verification = await recoveryClient.verifyWithRecoveryKey(params.encodedRecoveryKey);
    const restore = await waitForMatrixQaNonEmptyRoomKeyRestore({
      client: recoveryClient,
      recoveryKey: params.encodedRecoveryKey,
      timeoutMs: params.context.timeoutMs,
    });
    return {
      faultHits: proxy.hits(),
      restore,
      verification,
    };
  } finally {
    await recoveryClient.stop().catch(() => undefined);
    await proxy.stop();
  }
}

function assertMatrixQaFaultedRecoveryOwnerVerificationRequired(
  faulted: Awaited<ReturnType<typeof runMatrixQaFaultedRecoveryOwnerVerification>>,
) {
  if (faulted.faultHits.length === 0) {
    throw new Error("Matrix E2EE owner signature fault proxy was not exercised");
  }
  if (faulted.verification.success) {
    throw new Error(
      "Matrix E2EE recovery verification unexpectedly succeeded while owner signature upload was blocked",
    );
  }
  if (!faulted.verification.recoveryKeyAccepted) {
    throw new Error("Matrix E2EE recovery key was not accepted");
  }
  if (!faulted.verification.backupUsable) {
    throw new Error("Matrix E2EE recovery key did not leave room-key backup usable");
  }
  if (faulted.verification.deviceOwnerVerified) {
    throw new Error("Matrix E2EE recovery device should still require Matrix identity trust");
  }
  if (!faulted.restore.success) {
    throw new Error(
      `Matrix E2EE room-key backup restore failed after owner-verification fault: ${faulted.restore.error ?? "unknown error"}`,
    );
  }
}

function assertMatrixQaExpectedBootstrapFailure(params: {
  faultHits: MatrixQaFaultProxyHit[];
  result: MatrixQaE2eeBootstrapResult;
}) {
  if (params.faultHits.length === 0) {
    throw new Error("Matrix E2EE bootstrap fault proxy was not exercised");
  }
  if (params.result.success) {
    throw new Error(
      "Matrix E2EE bootstrap unexpectedly succeeded while room-key backup was faulted",
    );
  }
  const bootstrapError = params.result.error ?? "";
  if (!bootstrapError.toLowerCase().includes("room key backup")) {
    throw new Error(`Matrix E2EE bootstrap failed for an unexpected reason: ${bootstrapError}`);
  }
  return bootstrapError;
}

async function withMatrixQaE2eeDriver<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (client: MatrixQaE2eeScenarioClient) => Promise<T>,
  opts: { actorId?: "driver" | `driver-${string}` } = {},
) {
  const client = await createMatrixQaE2eeDriverClient(context, scenarioId, opts);
  try {
    return await run(client);
  } finally {
    await client.stop();
  }
}

async function createMatrixQaE2eeRegisteredScenarioClient(params: {
  account: Awaited<ReturnType<typeof registerMatrixQaE2eeScenarioAccount>>;
  actorId: `driver-${string}`;
  context: MatrixQaScenarioContext;
  scenarioId: MatrixQaE2eeScenarioId;
}) {
  return await createMatrixQaE2eeScenarioClient({
    accessToken: params.account.accessToken,
    actorId: params.actorId,
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

async function withMatrixQaIsolatedE2eeDriverRoom<T>(
  context: MatrixQaScenarioContext,
  scenarioId: MatrixQaE2eeScenarioId,
  run: (params: {
    client: MatrixQaE2eeScenarioClient;
    driverUserId: string;
    roomId: string;
    roomKey: string;
  }) => Promise<T>,
) {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error(
      "Matrix E2EE isolated driver room scenario requires hard gateway restart support",
    );
  }
  const accountId = context.sutAccountId ?? "sut";
  const configPath = requireMatrixQaGatewayConfigPath(context);
  const accountConfig = await readMatrixQaGatewayMatrixAccount({
    accountId,
    configPath,
  });
  const originalGroups = isMatrixQaPlainRecord(accountConfig.groups) ? accountConfig.groups : {};
  const originalGroupAllowFrom = Array.isArray(accountConfig.groupAllowFrom)
    ? accountConfig.groupAllowFrom
    : undefined;
  const originalGroupPolicy = accountConfig.groupPolicy;
  const driverAccount = await registerMatrixQaE2eeScenarioAccount({
    context,
    deviceName: "OpenClaw Matrix QA Isolated E2EE Driver",
    localpartPrefix: "qa-e2ee-driver",
    scenarioId,
  });
  const driverApi = createMatrixQaClient({
    accessToken: driverAccount.accessToken,
    baseUrl: context.baseUrl,
  });
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  const roomId = await driverApi.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [context.observerUserId, context.sutUserId],
    name: `Matrix QA ${scenarioId} Isolated E2EE Room`,
  });
  await Promise.all([
    createMatrixQaClient({
      accessToken: context.observerAccessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
    createMatrixQaClient({
      accessToken: context.sutAccessToken,
      baseUrl: context.baseUrl,
    }).joinRoom(roomId),
  ]);

  const isolatedGroups = {
    [roomId]: {
      enabled: true,
      requireMention: true,
    },
  };
  const applyPatch = async (accountPatch: Record<string, unknown>) => {
    await context.restartGatewayAfterStateMutation?.(
      async () => {
        await patchMatrixQaGatewayMatrixAccount({
          accountId,
          accountPatch,
          configPath,
        });
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
  };

  let patchedGateway = false;
  let client: MatrixQaE2eeScenarioClient | undefined;
  try {
    await applyPatch({
      groupAllowFrom: [driverAccount.userId],
      groupPolicy: "allowlist",
      groups: isolatedGroups,
    });
    patchedGateway = true;
    const actorId: `driver-${string}` = `driver-${scenarioId
      .replace(/^matrix-e2ee-/, "")
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 28)}`;
    client = await createMatrixQaE2eeRegisteredScenarioClient({
      account: driverAccount,
      actorId,
      context,
      scenarioId,
    });
    await Promise.all([
      client.waitForJoinedMember({
        roomId,
        timeoutMs: context.timeoutMs,
        userId: context.sutUserId,
      }),
      client.waitForJoinedMember({
        roomId,
        timeoutMs: context.timeoutMs,
        userId: context.observerUserId,
      }),
    ]);
    return await run({
      client,
      driverUserId: driverAccount.userId,
      roomId,
      roomKey,
    });
  } finally {
    await client?.stop().catch(() => undefined);
    if (patchedGateway) {
      const restorePatch: Record<string, unknown> = {
        groupAllowFrom: originalGroupAllowFrom,
        groupPolicy: originalGroupPolicy,
        groups: originalGroups,
      };
      await applyPatch(restorePatch).catch(() => undefined);
    }
  }
}

async function runMatrixQaE2eeTopLevelWithClient(
  context: MatrixQaScenarioContext,
  params: {
    client: MatrixQaE2eeScenarioClient;
    driverUserId: string;
    roomId: string;
    roomKey: string;
    tokenPrefix: string;
  },
) {
  const startSince = await params.client.prime();
  const token = buildMatrixQaToken(params.tokenPrefix);
  const body = buildMentionPrompt(context.sutUserId, token);
  const driverEventId = await params.client.sendTextMessage({
    body,
    mentionUserIds: [context.sutUserId],
    roomId: params.roomId,
  });
  const matched = await params.client.waitForRoomEvent({
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: params.roomId,
        sutUserId: context.sutUserId,
        token,
      }) && event.relatesTo === undefined,
    roomId: params.roomId,
    timeoutMs: context.timeoutMs,
  });
  const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
  assertTopLevelReplyArtifact("E2EE reply", reply);
  return {
    driverEventId,
    driverUserId: params.driverUserId,
    reply,
    roomId: params.roomId,
    roomKey: params.roomKey,
    since: matched.since ?? startSince,
    token,
  };
}

async function runMatrixQaE2eeTopLevelScenario(
  context: MatrixQaScenarioContext,
  params: {
    scenarioId: MatrixQaE2eeScenarioId;
    tokenPrefix: string;
  },
) {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(context, params.scenarioId);
  return await withMatrixQaE2eeDriver(context, params.scenarioId, async (client) => {
    return await runMatrixQaE2eeTopLevelWithClient(context, {
      client,
      driverUserId: context.driverUserId,
      roomId,
      roomKey,
      tokenPrefix: params.tokenPrefix,
    });
  });
}

export async function runMatrixQaE2eeBasicReplyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const result = await runMatrixQaE2eeTopLevelScenario(context, {
    scenarioId: "matrix-e2ee-basic-reply",
    tokenPrefix: "MATRIX_QA_E2EE_BASIC",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: result.roomKey,
      roomId: result.roomId,
    },
    details: [
      `encrypted room key: ${result.roomKey}`,
      `encrypted room id: ${result.roomId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("E2EE reply", result.reply),
    ].join("\n"),
  };
}

export async function runMatrixQaE2eeThreadFollowUpScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(
    context,
    "matrix-e2ee-thread-follow-up",
  );
  const result = await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-thread-follow-up",
    async (client) => {
      await client.prime();
      const rootEventId = await client.sendTextMessage({
        body: `E2EE thread root ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const token = buildMatrixQaToken("MATRIX_QA_E2EE_THREAD");
      const driverEventId = await client.sendTextMessage({
        body: buildMentionPrompt(context.sutUserId, token),
        mentionUserIds: [context.sutUserId],
        replyToEventId: rootEventId,
        roomId,
        threadRootEventId: rootEventId,
      });
      const matched = await client.waitForRoomEvent({
        predicate: (event) =>
          isMatrixQaExactMarkerReply(event, {
            roomId,
            sutUserId: context.sutUserId,
            token,
          }) &&
          event.relatesTo?.relType === "m.thread" &&
          event.relatesTo.eventId === rootEventId,
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
      assertThreadReplyArtifact(reply, {
        expectedRootEventId: rootEventId,
        label: "E2EE threaded reply",
      });
      return {
        driverEventId,
        reply,
        rootEventId,
        token,
      };
    },
  );
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      rootEventId: result.rootEventId,
      roomKey,
      roomId,
    },
    details: [
      `encrypted room key: ${roomKey}`,
      `encrypted room id: ${roomId}`,
      `thread root event: ${result.rootEventId}`,
      `mention trigger event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("E2EE threaded reply", result.reply),
    ].join("\n"),
  };
}

export async function runMatrixQaE2eeBootstrapSuccessScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(context, "matrix-e2ee-bootstrap-success", async (client) => {
    const result = await client.bootstrapOwnDeviceVerification({
      forceResetCrossSigning: true,
    });
    assertMatrixQaBootstrapSucceeded("driver", result);
    return {
      artifacts: {
        backupCreatedVersion: result.verification.backupVersion,
        bootstrapActor: "driver",
        bootstrapSuccess: true,
        currentDeviceId: result.verification.deviceId,
        recoveryKeyId: result.verification.recoveryKeyId,
        recoveryKeyStored: result.verification.recoveryKeyStored,
      },
      details: [
        "driver bootstrap succeeded through real Matrix crypto bootstrap",
        `device verified: ${result.verification.verified ? "yes" : "no"}`,
        `cross-signing verified: ${result.verification.crossSigningVerified ? "yes" : "no"}`,
        `signed by owner: ${result.verification.signedByOwner ? "yes" : "no"}`,
        `cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`,
        `room-key backup version: ${result.verification.backupVersion ?? "<none>"}`,
        `recovery key id: ${result.verification.recoveryKeyId ?? "<none>"}`,
      ].join("\n"),
    };
  });
}

export async function runMatrixQaE2eeRecoveryKeyLifecycleScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-recovery-key-lifecycle",
    async (client) => {
      const { roomId } = resolveMatrixQaE2eeScenarioGroupRoom(
        context,
        "matrix-e2ee-recovery-key-lifecycle",
      );
      const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const recoveryKey = ready.recoveryKey;
      const encodedRecoveryKey = recoveryKey?.encodedPrivateKey?.trim();
      if (!encodedRecoveryKey) {
        throw new Error("Matrix E2EE bootstrap did not expose an encoded recovery key");
      }
      const seededEventId = await client.sendTextMessage({
        body: `E2EE recovery-key restore seed ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const recoveryDevice = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Recovery Restore Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!recoveryDevice.deviceId) {
        throw new Error("Matrix E2EE recovery login did not return a secondary device id");
      }
      const recoveryClient = await createMatrixQaE2eeScenarioClient({
        accessToken: recoveryDevice.accessToken,
        actorId: `driver-recovery-${randomUUID().slice(0, 8)}`,
        baseUrl: context.baseUrl,
        deviceId: recoveryDevice.deviceId,
        observedEvents: context.observedEvents,
        outputDir: requireMatrixQaE2eeOutputDir(context),
        password: recoveryDevice.password,
        scenarioId: "matrix-e2ee-recovery-key-lifecycle",
        timeoutMs: context.timeoutMs,
        userId: recoveryDevice.userId,
      });
      let cleanupRecoveryDevice = true;
      try {
        const recoveryVerification = await recoveryClient.verifyWithRecoveryKey(encodedRecoveryKey);
        if (!recoveryVerification.success) {
          throw new Error(
            `Matrix E2EE recovery device verification failed: ${recoveryVerification.error ?? "unknown error"}`,
          );
        }
        const restored = await waitForMatrixQaNonEmptyRoomKeyRestore({
          client: recoveryClient,
          recoveryKey: encodedRecoveryKey,
          timeoutMs: context.timeoutMs,
        });
        const reset = await recoveryClient.resetRoomKeyBackup();
        if (!reset.success) {
          throw new Error(
            `Matrix E2EE room-key backup reset failed: ${reset.error ?? "unknown error"}`,
          );
        }
        const resetRecoveryKey = await recoveryClient.getRecoveryKey();
        const resetEncodedRecoveryKey = resetRecoveryKey?.encodedPrivateKey?.trim();
        if (resetEncodedRecoveryKey && resetEncodedRecoveryKey !== encodedRecoveryKey) {
          const ownerRecovery = await client.verifyWithRecoveryKey(resetEncodedRecoveryKey);
          if (!ownerRecovery.success) {
            throw new Error(
              `Matrix E2EE owner could not refresh recovery key after backup reset: ${
                ownerRecovery.error ?? "unknown error"
              }`,
            );
          }
        }
        await recoveryClient.stop();
        await client.stop().catch(() => undefined);
        await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
        cleanupRecoveryDevice = false;
        return {
          artifacts: {
            backupCreatedVersion: reset.createdVersion,
            backupReset: reset.success,
            backupRestored: restored.success,
            bootstrapActor: "driver",
            bootstrapSuccess: ready.bootstrap?.success ?? true,
            recoveryDeviceId: recoveryDevice.deviceId,
            recoveryKeyId: recoveryKey?.keyId ?? null,
            recoveryKeyUsable:
              recoveryVerification.recoveryKeyAccepted && recoveryVerification.backupUsable,
            recoveryKeyStored: true,
            recoveryVerified: recoveryVerification.deviceOwnerVerified,
            restoreImported: restored.imported,
            restoreTotal: restored.total,
            seededEventId,
          },
          details: [
            "driver recovery lifecycle completed through real Matrix recovery APIs",
            `bootstrap backup version: ${ready.verification.backupVersion ?? "<none>"}`,
            `seeded encrypted event: ${seededEventId}`,
            `recovery device: ${recoveryDevice.deviceId}`,
            `recovery key usable: ${recoveryVerification.backupUsable ? "yes" : "no"}`,
            `recovery device verified: ${recoveryVerification.deviceOwnerVerified ? "yes" : "no"}`,
            `restore imported/total: ${restored.imported}/${restored.total}`,
            `restore loaded from secret storage: ${restored.loadedFromSecretStorage ? "yes" : "no"}`,
            `reset previous version: ${reset.previousVersion ?? "<none>"}`,
            `reset created version: ${reset.createdVersion ?? "<none>"}`,
          ].join("\n"),
        };
      } finally {
        if (cleanupRecoveryDevice) {
          await recoveryClient.stop().catch(() => undefined);
          await client.stop().catch(() => undefined);
          await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
        }
      }
    },
  );
}

export async function runMatrixQaE2eeRecoveryOwnerVerificationRequiredScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-recovery-owner-verification-required",
    async (client) => {
      const { roomId } = resolveMatrixQaE2eeScenarioGroupRoom(
        context,
        "matrix-e2ee-recovery-owner-verification-required",
      );
      const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const recoveryKey = ready.recoveryKey;
      const encodedRecoveryKey = recoveryKey?.encodedPrivateKey?.trim();
      if (!encodedRecoveryKey) {
        throw new Error("Matrix E2EE bootstrap did not expose an encoded recovery key");
      }
      const seededEventId = await client.sendTextMessage({
        body: `E2EE recovery owner-verification seed ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const recoveryDevice = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Owner Verification Required Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!recoveryDevice.deviceId) {
        throw new Error("Matrix E2EE recovery login did not return a secondary device id");
      }
      try {
        const faulted = await runMatrixQaFaultedRecoveryOwnerVerification({
          accessToken: recoveryDevice.accessToken,
          context,
          deviceId: recoveryDevice.deviceId,
          encodedRecoveryKey,
          userId: recoveryDevice.userId,
        });
        assertMatrixQaFaultedRecoveryOwnerVerificationRequired(faulted);
        return {
          artifacts: {
            backupRestored: faulted.restore.success,
            backupUsable: faulted.verification.backupUsable,
            faultHitCount: faulted.faultHits.length,
            faultedEndpoints: faulted.faultHits.map((hit) => hit.path),
            faultRuleId: MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
            recoveryDeviceId: recoveryDevice.deviceId,
            recoveryKeyAccepted: faulted.verification.recoveryKeyAccepted,
            recoveryKeyId: recoveryKey?.keyId ?? null,
            recoveryVerified: faulted.verification.deviceOwnerVerified,
            restoreImported: faulted.restore.imported,
            restoreTotal: faulted.restore.total,
            verificationSuccess: faulted.verification.success,
          },
          details: [
            "driver recovery key unlocked backup while owner signature upload was blocked",
            `seeded encrypted event: ${seededEventId}`,
            `recovery device: ${recoveryDevice.deviceId}`,
            `fault hits: ${faulted.faultHits.length}`,
            `recovery key accepted: ${faulted.verification.recoveryKeyAccepted ? "yes" : "no"}`,
            `backup usable: ${faulted.verification.backupUsable ? "yes" : "no"}`,
            `device owner verified: ${faulted.verification.deviceOwnerVerified ? "yes" : "no"}`,
            `restore imported/total: ${faulted.restore.imported}/${faulted.restore.total}`,
          ].join("\n"),
        };
      } finally {
        await client.stop().catch(() => undefined);
        await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
      }
    },
  );
}

function assertMatrixQaCliE2eeStatus(
  label: string,
  status: MatrixQaCliVerificationStatus,
  opts: { allowUntrustedMatchingKey?: boolean } = {},
) {
  if (
    status.verified !== true ||
    status.crossSigningVerified !== true ||
    status.signedByOwner !== true ||
    !isMatrixQaCliBackupUsable(status.backup, opts)
  ) {
    throw new Error(
      `${label} did not leave the CLI account fully verified and backup-usable: ownerVerified=${
        status.verified === true &&
        status.crossSigningVerified === true &&
        status.signedByOwner === true
          ? "yes"
          : "no"
      }, backupUsable=${isMatrixQaCliBackupUsable(status.backup, opts) ? "yes" : "no"}${
        status.backup?.keyLoadError ? `, backupError=${status.backup.keyLoadError}` : ""
      }`,
    );
  }
}

async function runMatrixQaCliExpectedFailure(params: {
  args: string[];
  start: (args: string[], timeoutMs?: number) => MatrixQaCliSession;
  timeoutMs: number;
}): Promise<MatrixQaCliRunResult> {
  const session = params.start(params.args, params.timeoutMs);
  try {
    const result = await session.wait();
    throw new Error(
      `${formatMatrixQaCliCommand(params.args)} unexpectedly succeeded with stdout:\n${redactMatrixQaCliOutput(
        result.stdout,
      )}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("unexpectedly succeeded")) {
      throw error;
    }
    const output = session.output();
    if (!output.stdout.trim() && !output.stderr.trim()) {
      throw error;
    }
    return {
      args: params.args,
      exitCode: 1,
      stderr: output.stderr,
      stdout: output.stdout,
    };
  } finally {
    session.kill();
  }
}

function buildMatrixQaCliE2eeAccountConfig(params: {
  accountId: string;
  accessToken: string;
  baseUrl: string;
  deviceId: string;
  encryption: boolean;
  name: string;
  password?: string;
  userId: string;
}) {
  return {
    ...buildMatrixQaPluginActivationConfig(),
    channels: {
      matrix: {
        defaultAccount: params.accountId,
        accounts: {
          [params.accountId]: {
            accessToken: params.accessToken,
            deviceId: params.deviceId,
            encryption: params.encryption,
            homeserver: params.baseUrl,
            initialSyncLimit: 1,
            name: params.name,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            ...(params.password ? { password: params.password } : {}),
            startupVerification: "off",
            userId: params.userId,
          },
        },
      },
    },
  };
}

async function readMatrixQaCliConfig(pathname: string): Promise<{
  channels?: {
    matrix?: {
      accounts?: Record<string, Record<string, unknown>>;
      defaultAccount?: string;
    };
  };
}> {
  return JSON.parse(await readFile(pathname, "utf8")) as {
    channels?: {
      matrix?: {
        accounts?: Record<string, Record<string, unknown>>;
        defaultAccount?: string;
      };
    };
  };
}

export async function runMatrixQaE2eeCliAccountAddEnableE2eeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-add-e2ee";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Account Add Owner",
    scenarioId: "matrix-e2ee-cli-account-add-enable-e2ee",
  });
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-account-add-enable-e2ee",
    context,
  });
  try {
    const addResult = await cli.run([
      "matrix",
      "account",
      "add",
      "--account",
      accountId,
      "--name",
      "Matrix QA CLI Account Add E2EE",
      "--homeserver",
      context.baseUrl,
      "--user-id",
      account.userId,
      "--password",
      account.password,
      "--device-name",
      "OpenClaw Matrix QA CLI Account Add E2EE",
      "--allow-private-network",
      "--enable-e2ee",
      "--json",
    ]);
    const addArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "account-add-enable-e2ee",
      result: addResult,
      rootDir: cli.rootDir,
    });
    const added = parseMatrixQaCliJson(addResult) as MatrixQaCliAccountAddStatus;
    if (added.accountId !== accountId || added.encryptionEnabled !== true) {
      throw new Error(
        "Matrix CLI account add did not report E2EE enabled for the expected account",
      );
    }
    if (added.verificationBootstrap?.attempted !== true) {
      throw new Error("Matrix CLI account add did not attempt verification bootstrap");
    }
    if (added.verificationBootstrap.success !== true) {
      throw new Error(
        `Matrix CLI account add verification bootstrap failed: ${added.verificationBootstrap.error ?? "unknown error"}`,
      );
    }

    const statusResult = await cli.run([
      "matrix",
      "verify",
      "status",
      "--account",
      accountId,
      "--json",
    ]);
    const statusArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "verify-status",
      result: statusResult,
      rootDir: cli.rootDir,
    });
    const status = parseMatrixQaCliJson(statusResult) as MatrixQaCliVerificationStatus;
    assertMatrixQaCliE2eeStatus("Matrix CLI account add --enable-e2ee", status);
    const cliDeviceId = status.deviceId ?? null;

    return {
      artifacts: {
        accountId,
        backupVersion: added.verificationBootstrap.backupVersion ?? null,
        cliDeviceId,
        encryptionEnabled: added.encryptionEnabled,
        verificationBootstrapAttempted: added.verificationBootstrap.attempted,
        verificationBootstrapSuccess: added.verificationBootstrap.success,
      },
      details: [
        "Matrix CLI account add --enable-e2ee created an encrypted, verified account",
        `account add stdout: ${addArtifacts.stdoutPath}`,
        `account add stderr: ${addArtifacts.stderrPath}`,
        `verify status stdout: ${statusArtifacts.stdoutPath}`,
        `verify status stderr: ${statusArtifacts.stderrPath}`,
        `cli device: ${cliDeviceId ?? "<unknown>"}`,
        `cli verified by owner: ${status.verified ? "yes" : "no"}`,
        `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-setup";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Setup Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Setup Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI encryption setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Encryption Setup",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupResult = await cli.run([
      "matrix",
      "encryption",
      "setup",
      "--account",
      accountId,
      "--json",
    ]);
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup",
      result: setupResult,
      rootDir: cli.rootDir,
    });
    const setup = parseMatrixQaCliJson(setupResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      setup.accountId !== accountId ||
      setup.success !== true ||
      setup.encryptionChanged !== true ||
      setup.bootstrap?.success !== true ||
      !setup.status
    ) {
      throw new Error(
        `Matrix CLI encryption setup did not report a successful E2EE upgrade: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup", setup.status);

    const statusResult = await cli.run([
      "matrix",
      "verify",
      "status",
      "--account",
      accountId,
      "--json",
    ]);
    const statusArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "verify-status",
      result: statusResult,
      rootDir: cli.rootDir,
    });
    const status = parseMatrixQaCliJson(statusResult) as MatrixQaCliVerificationStatus;
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup status", status);

    return {
      artifacts: {
        accountId,
        cliDeviceId: status.deviceId ?? cliDevice.deviceId,
        encryptionChanged: setup.encryptionChanged,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup upgraded an existing account and bootstrapped verification",
        `encryption setup stdout: ${setupArtifacts.stdoutPath}`,
        `encryption setup stderr: ${setupArtifacts.stderrPath}`,
        `verify status stdout: ${statusArtifacts.stdoutPath}`,
        `verify status stderr: ${statusArtifacts.stderrPath}`,
        `cli device: ${status.deviceId ?? cliDevice.deviceId}`,
        `cli verified by owner: ${status.verified ? "yes" : "no"}`,
        `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupIdempotentScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-idempotent";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Idempotent Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-idempotent",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Idempotent Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI idempotent setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-idempotent",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: true,
      name: "Matrix QA CLI Encryption Setup Idempotent",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupArgs = ["matrix", "encryption", "setup", "--account", accountId, "--json"];
    const firstResult = await cli.run(setupArgs);
    const firstArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-first",
      result: firstResult,
      rootDir: cli.rootDir,
    });
    const first = parseMatrixQaCliJson(firstResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      first.accountId !== accountId ||
      first.success !== true ||
      first.encryptionChanged !== false ||
      first.bootstrap?.success !== true ||
      !first.status
    ) {
      throw new Error(
        `Matrix CLI encryption setup was not idempotent on first run: ${first.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup idempotent first run", first.status);

    const secondResult = await cli.run(setupArgs);
    const secondArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-second",
      result: secondResult,
      rootDir: cli.rootDir,
    });
    const second = parseMatrixQaCliJson(secondResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      second.accountId !== accountId ||
      second.success !== true ||
      second.encryptionChanged !== false ||
      second.bootstrap?.success !== true ||
      !second.status
    ) {
      throw new Error(
        `Matrix CLI encryption setup was not idempotent on second run: ${second.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup idempotent second run", second.status);

    return {
      artifacts: {
        accountId,
        cliDeviceId: second.status.deviceId ?? cliDevice.deviceId,
        firstEncryptionChanged: first.encryptionChanged,
        secondEncryptionChanged: second.encryptionChanged,
        setupSuccess: second.success,
        verificationBootstrapSuccess: second.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup stayed idempotent on an already encrypted account",
        `first setup stdout: ${firstArtifacts.stdoutPath}`,
        `first setup stderr: ${firstArtifacts.stderrPath}`,
        `second setup stdout: ${secondArtifacts.stdoutPath}`,
        `second setup stderr: ${secondArtifacts.stderrPath}`,
        `cli device: ${second.status.deviceId ?? cliDevice.deviceId}`,
        `first encryption changed: ${first.encryptionChanged ? "yes" : "no"}`,
        `second encryption changed: ${second.encryptionChanged ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-failure";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Failure Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Failure Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI bootstrap-failure login did not return a device id");
  }
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.baseUrl,
    rules: [buildRoomKeyBackupUnavailableFaultRule(cliDevice.accessToken)],
  });
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-bootstrap-failure",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: proxy.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Encryption Setup Bootstrap Failure",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const failed = await runMatrixQaCliExpectedFailure({
      args: ["matrix", "encryption", "setup", "--account", accountId, "--json"],
      start: cli.start,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-bootstrap-failure",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus;
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI encryption setup failure did not report unsuccessful bootstrap");
    }
    const faultHits = proxy.hits();
    if (faultHits.length === 0) {
      throw new Error("Matrix CLI encryption setup bootstrap-failure proxy was not exercised");
    }
    const bootstrapError = payload.bootstrap?.error ?? "";
    if (!bootstrapError.toLowerCase().includes("room key backup")) {
      throw new Error(
        `Matrix CLI encryption setup failed for an unexpected reason: ${bootstrapError}`,
      );
    }

    return {
      artifacts: {
        accountId,
        bootstrapErrorPreview: bootstrapError.slice(0, 240),
        bootstrapSuccess: false,
        cliDeviceId: cliDevice.deviceId,
        faultedEndpoint: faultHits[0]?.path,
        faultHitCount: faultHits.length,
        faultRuleId: MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
      },
      details: [
        "Matrix CLI encryption setup surfaced a bootstrap failure from a faulted room-key backup endpoint",
        `failure stdout: ${artifacts.stdoutPath}`,
        `failure stderr: ${artifacts.stderrPath}`,
        `fault hits: ${faultHits.length}`,
        `fault endpoint: ${faultHits[0]?.path ?? "<none>"}`,
        `bootstrap error: ${bootstrapError}`,
      ].join("\n"),
    };
  } finally {
    await Promise.all([cli.dispose(), proxy.stop().catch(() => undefined)]);
  }
}

export async function runMatrixQaE2eeCliRecoveryKeySetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-recovery-key-setup";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Recovery Key Owner",
    scenarioId: "matrix-e2ee-cli-recovery-key-setup",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-recovery-key-setup",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
    client: owner,
    label: "driver",
  });
  const encodedRecoveryKey = ready.recoveryKey?.encodedPrivateKey?.trim();
  if (!encodedRecoveryKey) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI recovery-key setup did not expose a recovery key");
  }
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Recovery Key Setup Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI recovery-key setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-recovery-key-setup",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Recovery Key Setup",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupResult = await cli.run([
      "matrix",
      "encryption",
      "setup",
      "--account",
      accountId,
      "--recovery-key",
      encodedRecoveryKey,
      "--json",
    ]);
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "recovery-key-setup",
      result: setupResult,
      rootDir: cli.rootDir,
    });
    const setup = parseMatrixQaCliJson(setupResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      setup.accountId !== accountId ||
      setup.success !== true ||
      setup.encryptionChanged !== true ||
      setup.bootstrap?.success !== true ||
      !setup.status
    ) {
      throw new Error(
        `Matrix CLI recovery-key encryption setup did not succeed: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI recovery-key encryption setup", setup.status, {
      allowUntrustedMatchingKey: true,
    });

    return {
      artifacts: {
        accountId,
        backupVersion: setup.status.backupVersion ?? ready.verification.backupVersion ?? null,
        cliDeviceId: setup.status.deviceId ?? cliDevice.deviceId,
        encryptionChanged: setup.encryptionChanged,
        recoveryKeyId: ready.recoveryKey?.keyId ?? null,
        recoveryKeyStored: true,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup accepted a recovery key on a second device",
        `recovery setup stdout: ${setupArtifacts.stdoutPath}`,
        `recovery setup stderr: ${setupArtifacts.stderrPath}`,
        `owner backup version: ${ready.verification.backupVersion ?? "<none>"}`,
        `recovery key id: ${ready.recoveryKey?.keyId ?? "<none>"}`,
        `cli device: ${setup.status.deviceId ?? cliDevice.deviceId}`,
        `cli verified by owner: ${setup.status.verified ? "yes" : "no"}`,
        `cli backup usable: ${
          isMatrixQaCliBackupUsable(setup.status.backup, { allowUntrustedMatchingKey: true })
            ? "yes"
            : "no"
        }`,
      ].join("\n"),
    };
  } finally {
    try {
      await owner.stop().catch(() => undefined);
      await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
    } finally {
      await cli.dispose();
    }
  }
}

export async function runMatrixQaE2eeCliRecoveryKeyInvalidScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-invalid-recovery-key";
  const invalidRecoveryKey = "not-a-valid-matrix-recovery-key";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Invalid Recovery Key Owner",
    scenarioId: "matrix-e2ee-cli-recovery-key-invalid",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-recovery-key-invalid",
  });
  const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
    client: owner,
    label: "cli invalid recovery-key owner",
  });
  if (!ready.recoveryKey?.encodedPrivateKey?.trim()) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI invalid recovery-key setup did not seed secret storage");
  }
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Invalid Recovery Key Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI invalid recovery-key login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-recovery-key-invalid",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Invalid Recovery Key",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const failed = await runMatrixQaCliExpectedFailure({
      args: [
        "matrix",
        "encryption",
        "setup",
        "--account",
        accountId,
        "--recovery-key",
        invalidRecoveryKey,
        "--json",
      ],
      start: cli.start,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "recovery-key-invalid",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus & {
      error?: string;
    };
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI invalid recovery-key setup did not report failure");
    }
    const failure = payload.bootstrap?.error ?? payload.error ?? "";
    if (!/recovery|secret|key/i.test(failure)) {
      throw new Error(
        `Matrix CLI invalid recovery-key setup failed for an unexpected reason: ${failure}`,
      );
    }
    if (failed.stdout.includes(invalidRecoveryKey) || failed.stderr.includes(invalidRecoveryKey)) {
      throw new Error("Matrix CLI invalid recovery-key output leaked the recovery key");
    }

    return {
      artifacts: {
        accountId,
        bootstrapErrorPreview: failure.slice(0, 240),
        bootstrapSuccess: false,
        cliDeviceId: cliDevice.deviceId,
        encryptionChanged: payload.encryptionChanged,
        recoveryKeyAccepted: false,
        recoveryKeyRejected: true,
        setupSuccess: false,
      },
      details: [
        "Matrix CLI encryption setup rejected an invalid recovery key without leaking it",
        `failure stdout: ${artifacts.stdoutPath}`,
        `failure stderr: ${artifacts.stderrPath}`,
        `cli device: ${cliDevice.deviceId}`,
        `failure: ${failure}`,
      ].join("\n"),
    };
  } finally {
    try {
      await owner.stop().catch(() => undefined);
      await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
    } finally {
      await cli.dispose();
    }
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupMultiAccountScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-multi-target";
  const decoyAccountId = "cli-multi-decoy";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Multi Account Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-multi-account",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Multi Account Target Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI multi-account setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-multi-account",
    context,
    initialConfig: {
      ...buildMatrixQaPluginActivationConfig(),
      channels: {
        matrix: {
          defaultAccount: decoyAccountId,
          accounts: {
            [decoyAccountId]: {
              accessToken: "decoy-token",
              deviceId: "DECOYDEVICE",
              encryption: false,
              homeserver: context.baseUrl,
              initialSyncLimit: 1,
              name: "Matrix QA CLI Multi Account Decoy",
              startupVerification: "off",
              userId: "@decoy:matrix-qa.test",
            },
            [accountId]: {
              accessToken: cliDevice.accessToken,
              deviceId: cliDevice.deviceId,
              encryption: false,
              homeserver: context.baseUrl,
              initialSyncLimit: 1,
              name: "Matrix QA CLI Multi Account Target",
              network: {
                dangerouslyAllowPrivateNetwork: true,
              },
              password: account.password,
              startupVerification: "off",
              userId: cliDevice.userId,
            },
          },
        },
      },
    },
  });
  try {
    const setupResult = await cli.run([
      "matrix",
      "encryption",
      "setup",
      "--account",
      accountId,
      "--json",
    ]);
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-multi-account",
      result: setupResult,
      rootDir: cli.rootDir,
    });
    const setup = parseMatrixQaCliJson(setupResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      setup.accountId !== accountId ||
      setup.success !== true ||
      setup.encryptionChanged !== true ||
      setup.bootstrap?.success !== true ||
      !setup.status
    ) {
      throw new Error(
        `Matrix CLI multi-account encryption setup did not target the requested account: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI multi-account encryption setup", setup.status);

    const config = await readMatrixQaCliConfig(cli.configPath);
    const matrix = config.channels?.matrix;
    const target = matrix?.accounts?.[accountId];
    const decoy = matrix?.accounts?.[decoyAccountId];
    const defaultAccountPreserved = matrix?.defaultAccount === decoyAccountId;
    const decoyAccountPreserved =
      decoy?.encryption === false &&
      decoy?.accessToken === "decoy-token" &&
      decoy?.deviceId === "DECOYDEVICE";
    if (!defaultAccountPreserved) {
      throw new Error("Matrix CLI multi-account setup changed the default account");
    }
    if (!decoyAccountPreserved) {
      throw new Error("Matrix CLI multi-account setup mutated the decoy account");
    }
    if (target?.encryption !== true) {
      throw new Error("Matrix CLI multi-account setup did not enable encryption on the target");
    }

    return {
      artifacts: {
        accountId,
        cliDeviceId: setup.status.deviceId ?? cliDevice.deviceId,
        decoyAccountPreserved,
        defaultAccountPreserved,
        encryptionChanged: setup.encryptionChanged,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup changed only the requested account in a multi-account config",
        `setup stdout: ${setupArtifacts.stdoutPath}`,
        `setup stderr: ${setupArtifacts.stderrPath}`,
        `default account preserved: ${defaultAccountPreserved ? "yes" : "no"}`,
        `decoy account preserved: ${decoyAccountPreserved ? "yes" : "no"}`,
        `cli device: ${setup.status.deviceId ?? cliDevice.deviceId}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliSetupThenGatewayReplyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error(
      "Matrix CLI setup gateway reply scenario requires hard gateway restart support",
    );
  }
  const gatewayConfigPath = requireMatrixQaGatewayConfigPath(context);
  const accountId = "cli-setup-gateway";
  const scenarioId = "matrix-e2ee-cli-setup-then-gateway-reply";
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Setup Gateway",
    scenarioId,
  });
  const driverAccount = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Setup Driver",
    scenarioId,
  });
  const driverApi = createMatrixQaClient({
    accessToken: driverAccount.accessToken,
    baseUrl: context.baseUrl,
  });
  const gatewayApi = createMatrixQaClient({
    accessToken: account.accessToken,
    baseUrl: context.baseUrl,
  });
  const roomId = await driverApi.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [account.userId],
    name: "Matrix QA CLI Setup Gateway E2EE",
  });
  await gatewayApi.joinRoom(roomId);

  const accountConfig = {
    accessToken: account.accessToken,
    deviceId: account.deviceId,
    dm: {
      allowFrom: [driverAccount.userId],
      enabled: true,
      policy: "allowlist",
      sessionScope: "per-room",
      threadReplies: "inbound",
    },
    enabled: true,
    encryption: false,
    groupAllowFrom: [driverAccount.userId],
    groupPolicy: "allowlist",
    groups: {
      [roomId]: {
        enabled: true,
        requireMention: true,
      },
    },
    homeserver: context.baseUrl,
    initialSyncLimit: 1,
    name: "Matrix QA CLI Setup Gateway",
    network: {
      dangerouslyAllowPrivateNetwork: true,
    },
    password: account.password,
    startupVerification: "off",
    threadReplies: "inbound",
    userId: account.userId,
  };
  await context.restartGatewayAfterStateMutation(
    async () => {
      await replaceMatrixQaGatewayMatrixAccount({
        accountConfig,
        accountId,
        configPath: gatewayConfigPath,
      });
    },
    {
      timeoutMs: context.timeoutMs,
      waitAccountId: accountId,
    },
  );
  await context.waitGatewayAccountReady?.(accountId, {
    timeoutMs: context.timeoutMs,
  });
  const cli = await createMatrixQaCliGatewayRuntime({
    artifactLabel: "cli-setup-then-gateway-reply",
    context,
  });
  try {
    const setupResult = await cli.run([
      "matrix",
      "encryption",
      "setup",
      "--account",
      accountId,
      "--json",
    ]);
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup",
      result: setupResult,
      rootDir: cli.rootDir,
    });
    const setup = parseMatrixQaCliJson(setupResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      setup.accountId !== accountId ||
      setup.success !== true ||
      setup.bootstrap?.success !== true
    ) {
      throw new Error(
        `Matrix CLI gateway account setup did not succeed: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    if (setup.status) {
      assertMatrixQaCliE2eeStatus("Matrix CLI gateway account setup", setup.status);
    }
    await context.restartGatewayAfterStateMutation(
      async () => {
        await patchMatrixQaGatewayMatrixAccount({
          accountPatch: {
            encryption: true,
            password: account.password,
          },
          accountId,
          configPath: gatewayConfigPath,
        });
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
    await context.waitGatewayAccountReady?.(accountId, {
      timeoutMs: context.timeoutMs,
    });
    const driverClient = await createMatrixQaE2eeScenarioClient({
      accessToken: driverAccount.accessToken,
      actorId: `driver-cli-setup-gateway-${randomUUID().slice(0, 8)}`,
      baseUrl: context.baseUrl,
      deviceId: driverAccount.deviceId,
      observedEvents: context.observedEvents,
      outputDir: requireMatrixQaE2eeOutputDir(context),
      password: driverAccount.password,
      scenarioId,
      timeoutMs: context.timeoutMs,
      userId: driverAccount.userId,
    });
    const replied = await (async () => {
      try {
        await ensureMatrixQaE2eeOwnDeviceVerified({
          client: driverClient,
          label: "Matrix CLI setup scenario driver",
        });
        await driverClient.waitForJoinedMember({
          roomId,
          timeoutMs: context.timeoutMs,
          userId: account.userId,
        });
        await driverClient.prime();
        const token = buildMatrixQaToken("MATRIX_QA_E2EE_CLI_GATEWAY");
        const driverEventId = await driverClient.sendTextMessage({
          body: buildMentionPrompt(account.userId, token),
          mentionUserIds: [account.userId],
          roomId,
        });
        const matched = await driverClient.waitForRoomEvent({
          predicate: (event) =>
            isMatrixQaExactMarkerReply(event, {
              roomId,
              sutUserId: account.userId,
              token,
            }) && event.relatesTo === undefined,
          roomId,
          timeoutMs: context.timeoutMs,
        });
        const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
        assertTopLevelReplyArtifact("gateway reply", reply);
        return {
          driverEventId,
          reply,
        };
      } finally {
        await driverClient.stop();
      }
    })();

    return {
      artifacts: {
        accountId,
        cliDeviceId: setup.status?.deviceId ?? account.deviceId ?? null,
        driverUserId: driverAccount.userId,
        encryptionChanged: setup.encryptionChanged,
        gatewayReply: replied.reply,
        gatewayUserId: account.userId,
        roomKey,
        roomId,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup left the gateway able to reply in an encrypted room",
        `setup stdout: ${setupArtifacts.stdoutPath}`,
        `setup stderr: ${setupArtifacts.stderrPath}`,
        `driver user: ${driverAccount.userId}`,
        `gateway user: ${account.userId}`,
        `encrypted room key: ${roomKey}`,
        `encrypted room id: ${roomId}`,
        `driver event: ${replied.driverEventId}`,
        ...buildMatrixReplyDetails("gateway reply", replied.reply),
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliSelfVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Self Verification Owner",
    scenarioId: "matrix-e2ee-cli-self-verification",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-self-verification",
  });
  try {
    const ownerReady = await ensureMatrixQaE2eeOwnDeviceVerified({
      client: owner,
      label: "CLI self-verification owner",
    });
    const encodedRecoveryKey = ownerReady.recoveryKey?.encodedPrivateKey?.trim();
    if (!encodedRecoveryKey) {
      throw new Error("Matrix E2EE self-verification scenario did not expose a recovery key");
    }
    const loginClient = createMatrixQaClient({
      baseUrl: context.baseUrl,
    });
    const cliDevice = await loginClient.loginWithPassword({
      deviceName: "OpenClaw Matrix QA CLI Self Verification Device",
      password: account.password,
      userId: account.userId,
    });
    if (!cliDevice.deviceId) {
      throw new Error("Matrix E2EE CLI verification login did not return a device id");
    }

    const cli = await createMatrixQaCliSelfVerificationRuntime({
      accountId,
      accessToken: cliDevice.accessToken,
      context,
      deviceId: cliDevice.deviceId,
      userId: cliDevice.userId,
    });
    try {
      const restoreResult = await cli.run(
        [
          "matrix",
          "verify",
          "backup",
          "restore",
          "--account",
          accountId,
          "--recovery-key-stdin",
          "--json",
        ],
        context.timeoutMs,
        `${encodedRecoveryKey}\n`,
      );
      const restoreArtifacts = await writeMatrixQaCliOutputArtifacts({
        label: "verify-backup-restore",
        result: restoreResult,
        rootDir: cli.rootDir,
      });
      const restored = parseMatrixQaCliJson(restoreResult) as MatrixQaCliBackupRestoreStatus;
      if (
        restored.success !== true ||
        restored.backup?.decryptionKeyCached !== true ||
        restored.backup?.matchesDecryptionKey !== true ||
        restored.backup?.keyLoadError
      ) {
        throw new Error(
          `Matrix CLI recovery key did not load matching room-key backup material before self-verification: ${
            restored.error ?? restored.backup?.keyLoadError ?? "unknown backup state"
          }`,
        );
      }
      const session = cli.start(
        [
          "matrix",
          "verify",
          "self",
          "--account",
          accountId,
          "--timeout-ms",
          String(context.timeoutMs),
        ],
        context.timeoutMs * 2,
      );
      try {
        const requestOutput = await session.waitForOutput(
          (output) => output.text.includes("Accept this verification request"),
          "self-verification request guidance",
          context.timeoutMs,
        );
        const cliTransactionId = parseMatrixQaCliSummaryField(requestOutput.text, "Transaction id");
        const ownerRequested = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner received CLI self-verification request",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requirePending: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        if (ownerRequested.canAccept) {
          await owner.acceptVerification(ownerRequested.id);
        }

        const sasOutput = await session.waitForOutput(
          (output) => /^SAS (?:emoji|decimals):/m.test(output.text),
          "SAS emoji or decimals",
          context.timeoutMs,
        );
        const cliSas = parseMatrixQaCliSasText(
          sasOutput.text,
          "interactive openclaw matrix verify self",
        );
        const ownerSas = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner SAS for CLI self-verification",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requireSas: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        const sasArtifact = assertMatrixQaCliSasMatches({
          cliSas,
          owner: ownerSas,
        });
        const ownerConfirm = owner.confirmVerificationSas(ownerSas.id);
        await session.writeStdin("yes\n");
        session.endStdin();
        await ownerConfirm;
        const completedCli = await session.wait();
        const selfVerificationArtifacts = await writeMatrixQaCliOutputArtifacts({
          label: "verify-self",
          result: completedCli,
          rootDir: cli.rootDir,
        });
        if (!/^Device verified by owner:\s*yes$/m.test(completedCli.stdout)) {
          throw new Error(
            "Interactive Matrix CLI self-verification did not report final device verification",
          );
        }
        if (!/^Cross-signing verified:\s*yes$/m.test(completedCli.stdout)) {
          throw new Error(
            "Interactive Matrix CLI self-verification did not report full Matrix identity trust",
          );
        }
        const completedOwner = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner completed CLI self-verification",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requireCompleted: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        const cliVerificationId =
          completedCli.stdout.match(/^Verification id:\s*(\S+)/m)?.[1] ?? "interactive-cli";
        const statusResult = await cli.run([
          "matrix",
          "verify",
          "status",
          "--account",
          accountId,
          "--json",
        ]);
        const statusArtifacts = await writeMatrixQaCliOutputArtifacts({
          label: "verify-status",
          result: statusResult,
          rootDir: cli.rootDir,
        });
        const status = parseMatrixQaCliJson(statusResult) as MatrixQaCliVerificationStatus;
        if (
          status.verified !== true ||
          status.crossSigningVerified !== true ||
          status.signedByOwner !== true ||
          status.backup?.trusted !== true ||
          status.backup?.matchesDecryptionKey !== true ||
          status.backup?.keyLoadError
        ) {
          throw new Error(
            `Matrix CLI device was not fully usable after SAS completion: ownerVerified=${
              status.verified === true &&
              status.crossSigningVerified === true &&
              status.signedByOwner === true
                ? "yes"
                : "no"
            }, backupUsable=${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}${
              status.backup?.keyLoadError ? `, backupError=${status.backup.keyLoadError}` : ""
            }`,
          );
        }
        return {
          artifacts: {
            completedVerificationIds: [cliVerificationId, completedOwner.id],
            currentDeviceId: status.deviceId ?? cliDevice.deviceId,
            ...(cliSas.kind === "emoji" ? { sasEmoji: sasArtifact } : {}),
            secondaryDeviceId: cliDevice.deviceId,
          },
          details: [
            "Matrix CLI self-verification established full Matrix identity trust through interactive openclaw matrix verify self",
            "cli secret config cleaned after run: yes",
            `cli backup restore stdout: ${restoreArtifacts.stdoutPath}`,
            `cli backup restore stderr: ${restoreArtifacts.stderrPath}`,
            `cli verify self stdout: ${selfVerificationArtifacts.stdoutPath}`,
            `cli verify self stderr: ${selfVerificationArtifacts.stderrPath}`,
            `cli verify status stdout: ${statusArtifacts.stdoutPath}`,
            `cli verify status stderr: ${statusArtifacts.stderrPath}`,
            `cli device: ${cliDevice.deviceId}`,
            `cli verification id: ${cliVerificationId}`,
            `owner-side verification id: ${completedOwner.id}`,
            `transaction: ${completedOwner.transactionId ?? "<none>"}`,
            `cli verified by owner: ${status.verified ? "yes" : "no"}`,
            `cli cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}`,
            `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
          ].join("\n"),
        };
      } finally {
        session.kill();
      }
    } finally {
      try {
        await cli.dispose();
      } finally {
        await owner.stop().catch(() => undefined);
        await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
      }
    }
  } finally {
    await owner.stop().catch(() => undefined);
  }
}

export async function runMatrixQaE2eeDeviceSasVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  if (!context.observerDeviceId) {
    throw new Error("Matrix E2EE observer device id is required for device SAS verification");
  }
  if (!context.driverDeviceId) {
    throw new Error("Matrix E2EE driver device id is required for device SAS verification");
  }
  const observerDeviceId = context.observerDeviceId;
  const driverDeviceId = context.driverDeviceId;
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-device-sas-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const result = await completeMatrixQaSasVerification({
        initiator: driver,
        recipient: observer,
        recipientUserId: context.observerUserId,
        request: {
          deviceId: observerDeviceId,
          userId: context.observerUserId,
        },
        timeoutMs: context.timeoutMs,
      });
      const driverTrust = await assertMatrixQaPeerDeviceTrusted({
        client: driver,
        deviceId: observerDeviceId,
        label: "driver",
        userId: context.observerUserId,
      });
      const observerTrust = await assertMatrixQaPeerDeviceTrusted({
        client: observer,
        deviceId: driverDeviceId,
        label: "observer",
        userId: context.driverUserId,
      });
      return {
        artifacts: {
          completedVerificationIds: [result.completedInitiator.id, result.completedRecipient.id],
          currentDeviceId: driverDeviceId,
          driverTrustsObserverDevice: driverTrust.verified,
          observerTrustsDriverDevice: observerTrust.verified,
          sasEmoji: result.sasEmoji,
          secondaryDeviceId: observerDeviceId,
        },
        details: [
          "driver-to-observer device verification completed with real SAS",
          `initiator transaction: ${result.completedInitiator.transactionId ?? "<none>"}`,
          `recipient transaction: ${result.completedRecipient.transactionId ?? "<none>"}`,
          `driver trusts observer device: ${driverTrust.verified ? "yes" : "no"}`,
          `observer trusts driver device: ${observerTrust.verified ? "yes" : "no"}`,
          `emoji: ${result.sasEmoji.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeQrVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  if (!context.observerDeviceId) {
    throw new Error("Matrix E2EE observer device id is required for QR verification");
  }
  if (!context.driverDeviceId) {
    throw new Error("Matrix E2EE driver device id is required for QR verification");
  }
  const observerDeviceId = context.observerDeviceId;
  const driverDeviceId = context.driverDeviceId;
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-qr-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const initiated = await driver.requestVerification({
        deviceId: observerDeviceId,
        userId: context.observerUserId,
      });
      const incoming = await waitForMatrixQaVerificationSummary({
        client: observer,
        label: "QR recipient request",
        predicate: (summary) =>
          !summary.initiatedByMe && sameMatrixQaVerificationTransaction(summary, initiated),
        timeoutMs: context.timeoutMs,
      });
      if (incoming.canAccept) {
        await observer.acceptVerification(incoming.id);
      }
      await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR request ready",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.phaseName === "ready",
        timeoutMs: context.timeoutMs,
      });
      const qr = await driver.generateVerificationQr(initiated.id);
      await observer.scanVerificationQr(incoming.id, qr.qrDataBase64);
      const reciprocate = await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR reciprocate",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.hasReciprocateQr,
        timeoutMs: context.timeoutMs,
      });
      await driver.confirmVerificationReciprocateQr(reciprocate.id);
      const qrByteCount = Buffer.from(qr.qrDataBase64, "base64").byteLength;
      const completedDriver = await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR driver complete",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.completed,
        timeoutMs: context.timeoutMs,
      });
      const completedObserver = await waitForMatrixQaVerificationSummary({
        client: observer,
        label: "QR observer complete",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, completedDriver) && summary.completed,
        timeoutMs: context.timeoutMs,
      });
      const driverTrust = await driver.getDeviceVerificationStatus(
        context.observerUserId,
        observerDeviceId,
      );
      const observerTrust = await observer.getDeviceVerificationStatus(
        context.driverUserId,
        driverDeviceId,
      );
      return {
        artifacts: {
          completedVerificationIds: [completedDriver.id, completedObserver.id],
          driverTrustsObserverDevice: driverTrust.verified,
          identityVerificationCompleted: true,
          observerTrustsDriverDevice: observerTrust.verified,
          qrBytes: qrByteCount,
          secondaryDeviceId: observerDeviceId,
        },
        details: [
          "driver-to-observer QR verification completed through real QR scan",
          `transaction: ${completedDriver.transactionId ?? "<none>"}`,
          `driver trusts observer device: ${driverTrust.verified ? "yes" : "no"}`,
          `observer trusts driver device: ${observerTrust.verified ? "yes" : "no"}`,
          `qr bytes: ${qrByteCount}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeStaleDeviceHygieneScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-stale-device-hygiene",
    async (client) => {
      await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const secondary = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Stale Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!secondary.deviceId) {
        throw new Error("Matrix stale-device login did not return a secondary device id");
      }
      const before = await client.listOwnDevices();
      if (!before.some((device) => device.deviceId === secondary.deviceId)) {
        throw new Error("Matrix stale-device list did not include the secondary login");
      }
      await client.stop().catch(() => undefined);
      const deleted = await client.deleteOwnDevices([secondary.deviceId]);
      const remainingDeviceIds = deleted.remainingDevices.map((device) => device.deviceId);
      if (remainingDeviceIds.includes(secondary.deviceId)) {
        throw new Error(
          "Matrix stale-device deletion left the secondary device in the device list",
        );
      }
      if (
        deleted.currentDeviceId &&
        !deleted.remainingDevices.some((device) => device.deviceId === deleted.currentDeviceId)
      ) {
        throw new Error("Matrix stale-device deletion removed the current device");
      }
      return {
        artifacts: {
          currentDeviceId: deleted.currentDeviceId,
          deletedDeviceIds: deleted.deletedDeviceIds,
          remainingDeviceIds,
          secondaryDeviceId: secondary.deviceId,
        },
        details: [
          "driver secondary device was created, observed, and removed through real device APIs",
          `current device: ${deleted.currentDeviceId ?? "<none>"}`,
          `deleted device: ${secondary.deviceId}`,
          `remaining devices: ${remainingDeviceIds.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeDmSasVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY);
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-dm-sas-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const result = await completeMatrixQaSasVerification({
        initiator: driver,
        recipient: observer,
        recipientUserId: context.observerUserId,
        request: {
          roomId,
          userId: context.observerUserId,
        },
        timeoutMs: context.timeoutMs,
      });
      if (
        result.completedInitiator.roomId !== roomId ||
        result.completedRecipient.roomId !== roomId
      ) {
        throw new Error("Matrix E2EE DM verification completed outside the expected DM room");
      }
      return {
        artifacts: {
          completedVerificationIds: [result.completedInitiator.id, result.completedRecipient.id],
          roomKey: MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
          sasEmoji: result.sasEmoji,
          verificationRoomId: roomId,
        },
        details: [
          "driver/observer encrypted DM verification completed with SAS in the expected room",
          `verification DM room: ${roomId}`,
          `transaction: ${result.completedInitiator.transactionId ?? "<none>"}`,
          `emoji: ${result.sasEmoji.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeRestartResumeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.restartGateway) {
    throw new Error("Matrix E2EE restart scenario requires gateway restart support");
  }
  const restartGateway = context.restartGateway;
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-restart-resume",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const first = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_BEFORE_RESTART",
      });
      await restartGateway();
      const recovered = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_AFTER_RESTART",
      });
      return {
        artifacts: {
          driverUserId,
          firstDriverEventId: first.driverEventId,
          firstReply: first.reply,
          recoveredDriverEventId: recovered.driverEventId,
          recoveredReply: recovered.reply,
          restartSignal: "gateway-restart",
          roomKey: recovered.roomKey,
          roomId: recovered.roomId,
        },
        details: [
          `encrypted room key: ${recovered.roomKey}`,
          `encrypted room id: ${recovered.roomId}`,
          `isolated driver user: ${driverUserId}`,
          `pre-restart event: ${first.driverEventId}`,
          ...buildMatrixReplyDetails("pre-restart reply", first.reply),
          `post-restart event: ${recovered.driverEventId}`,
          ...buildMatrixReplyDetails("post-restart reply", recovered.reply),
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeVerificationNoticeNoTriggerScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { roomId, roomKey } = resolveMatrixQaE2eeScenarioGroupRoom(
    context,
    "matrix-e2ee-verification-notice-no-trigger",
  );
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-verification-notice-no-trigger",
    async (client) => {
      await client.prime();
      const token = buildMatrixQaToken("MATRIX_QA_E2EE_VERIFY_NOTICE");
      const body = `Matrix verification started with ${context.driverUserId}; ${buildMentionPrompt(
        context.sutUserId,
        token,
      )}`;
      const noticeSentAt = Date.now();
      const noticeEventId = await client.sendNoticeMessage({
        body,
        mentionUserIds: [context.sutUserId],
        roomId,
      });
      const result = await client.waitForOptionalRoomEvent({
        predicate: (event) =>
          isMatrixQaE2eeNoticeTriggeredSutReply({
            event,
            noticeEventId,
            noticeSentAt,
            roomId,
            sutUserId: context.sutUserId,
            token,
          }),
        roomId,
        timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
      });
      if (result.matched) {
        throw new Error(`unexpected E2EE verification-notice reply: ${result.event.eventId}`);
      }
      return {
        artifacts: {
          expectedNoReplyWindowMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
          noticeEventId,
          roomKey,
          roomId,
        },
        details: [
          `encrypted room key: ${roomKey}`,
          `encrypted room id: ${roomId}`,
          `verification notice event: ${noticeEventId}`,
          `waited ${resolveMatrixQaNoReplyWindowMs(context.timeoutMs)}ms with no SUT reply`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeArtifactRedactionScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-artifact-redaction",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const result = await runMatrixQaE2eeTopLevelWithClient(context, {
        client,
        driverUserId,
        roomId,
        roomKey,
        tokenPrefix: "MATRIX_QA_E2EE_REDACT",
      });
      const leaked = context.observedEvents.some(
        (event) =>
          event.roomId === result.roomId &&
          (event.body?.includes(result.token) || event.formattedBody?.includes(result.token)),
      );
      if (!leaked) {
        throw new Error(
          "Matrix E2EE redaction scenario did not observe decrypted content in memory",
        );
      }
      return {
        artifacts: {
          driverEventId: result.driverEventId,
          driverUserId,
          reply: result.reply,
          roomKey: result.roomKey,
          roomId: result.roomId,
        },
        details: [
          "decrypted E2EE payload reached in-memory assertions only",
          "observed-event artifacts redact body/formatted_body unless OPENCLAW_QA_MATRIX_CAPTURE_CONTENT=1",
          `encrypted room id: ${result.roomId}`,
          `isolated driver user: ${driverUserId}`,
          ...buildMatrixReplyDetails("E2EE reply", result.reply),
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeMediaImageScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await withMatrixQaIsolatedE2eeDriverRoom(
    context,
    "matrix-e2ee-media-image",
    async ({ client, driverUserId, roomId, roomKey }) => {
      const startSince = await client.prime();
      const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
      const driverEventId = await client.sendImageMessage({
        body: triggerBody,
        buffer: createMatrixQaSplitColorImagePng(),
        contentType: "image/png",
        fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
        mentionUserIds: [context.sutUserId],
        roomId,
      });
      const attachmentEvent = await client.waitForRoomEvent({
        predicate: (event) =>
          event.roomId === roomId &&
          event.eventId === driverEventId &&
          event.sender === driverUserId &&
          event.attachment?.kind === "image" &&
          event.attachment.caption === triggerBody,
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const matched = await client.waitForRoomEvent({
        predicate: (event) =>
          event.roomId === roomId &&
          event.sender === context.sutUserId &&
          event.type === "m.room.message" &&
          event.relatesTo === undefined &&
          hasMatrixQaExpectedColorReply(event.body),
        roomId,
        timeoutMs: context.timeoutMs,
      });
      const reply: MatrixQaReplyArtifact = {
        eventId: matched.event.eventId,
        mentions: matched.event.mentions,
        relatesTo: matched.event.relatesTo,
        sender: matched.event.sender,
      };
      return {
        artifacts: {
          attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
          driverEventId,
          driverUserId,
          reply,
          roomKey,
          roomId,
        },
        details: [
          `encrypted room key: ${roomKey}`,
          `encrypted room id: ${roomId}`,
          `isolated driver user: ${driverUserId}`,
          `driver encrypted image event: ${driverEventId}`,
          `driver encrypted image filename: ${MATRIX_QA_IMAGE_ATTACHMENT_FILENAME}`,
          `driver encrypted image since: ${attachmentEvent.since ?? startSince ?? "<none>"}`,
          ...buildMatrixReplyDetails("E2EE image reply", reply),
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeKeyBootstrapFailureScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { faultHits, result } = await runMatrixQaFaultedE2eeBootstrap(context);
  const bootstrapError = assertMatrixQaExpectedBootstrapFailure({ faultHits, result });

  return {
    artifacts: {
      bootstrapActor: "driver",
      bootstrapErrorPreview: bootstrapError.slice(0, 240),
      bootstrapSuccess: result.success,
      faultedEndpoint: MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT,
      faultHitCount: faultHits.length,
      ...(faultHits[0]?.ruleId ? { faultRuleId: faultHits[0].ruleId } : {}),
    },
    details: [
      "Matrix E2EE bootstrap failure surfaced through real SDK bootstrap.",
      `faulted endpoint: GET ${MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT}`,
      `fault hits: ${faultHits.length}`,
      `bootstrap success: ${result.success ? "yes" : "no"}`,
      `bootstrap error: ${bootstrapError || "<none>"}`,
    ].join("\n"),
  };
}
