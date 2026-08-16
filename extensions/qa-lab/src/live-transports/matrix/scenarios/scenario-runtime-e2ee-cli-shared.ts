// Qa Matrix plugin module implements shared CLI scenario runtime E2EE behavior.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MatrixVerificationSummary } from "@openclaw/matrix/test-api.js";
import { createMatrixQaClient } from "../substrate/client.js";
import { createMatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import type { MatrixQaE2eeScenarioId } from "./scenario-contract.js";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  type MatrixQaCliRunResult,
} from "./scenario-runtime-cli.js";
import {
  formatMatrixQaSasEmoji,
  requireMatrixQaE2eeOutputDir,
  requireMatrixQaRegistrationToken,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export type MatrixQaCliVerificationStatus = {
  backup?: {
    decryptionKeyCached?: boolean | null;
    keyLoadError?: string | null;
    matchesDecryptionKey?: boolean | null;
    trusted?: boolean | null;
  };
  backupVersion?: string | null;
  crossSigningVerified?: boolean;
  encryptionEnabled?: boolean;
  pendingVerifications?: number;
  recoveryKeyStored?: boolean;
  serverDeviceKnown?: boolean;
  verified?: boolean;
  signedByOwner?: boolean;
  deviceId?: string | null;
  userId?: string | null;
};
export type MatrixQaCliEncryptionSetupStatus = {
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
export type MatrixQaCliAccountAddStatus = {
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
export type MatrixQaCliBackupRestoreStatus = {
  success?: boolean;
  backup?: MatrixQaCliVerificationStatus["backup"];
  error?: string;
};

export function isMatrixQaCliBackupUsable(
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

function parseMatrixQaCliJsonText(text: string): unknown {
  const candidate = text.trim();
  if (!candidate) {
    throw new Error("no JSON payload found");
  }
  return JSON.parse(candidate) as unknown;
}

export function parseMatrixQaCliJson(result: MatrixQaCliRunResult): unknown {
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

export function buildMatrixQaPluginActivationConfig() {
  return {
    plugins: {
      allow: ["matrix"],
      entries: {
        matrix: { enabled: true },
      },
    },
  };
}

export function buildMatrixQaEmptyMatrixCliConfig() {
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

export async function registerMatrixQaCliE2eeAccount(params: {
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

export async function createMatrixQaE2eeCliOwnerClient(params: {
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

export function parseMatrixQaCliSasText(
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

export function parseMatrixQaCliSummaryField(text: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
}

export async function writeMatrixQaCliOutputArtifacts(params: {
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

export async function assertMatrixQaPrivatePathMode(pathToCheck: string, label: string) {
  if (process.platform === "win32") {
    return;
  }
  const mode = (await stat(pathToCheck)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad: ${mode.toString(8)}`);
  }
}

export function assertMatrixQaCliSasMatches(params: {
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

export function isMatrixQaCliOwnerSelfVerification(params: {
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
