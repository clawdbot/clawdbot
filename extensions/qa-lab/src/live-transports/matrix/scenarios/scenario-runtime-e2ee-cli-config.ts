// Qa Matrix plugin module implements CLI config assertions for E2EE scenarios.
import { readFile } from "node:fs/promises";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  type MatrixQaCliRunResult,
  type MatrixQaCliSession,
} from "./scenario-runtime-cli.js";
import {
  buildMatrixQaPluginActivationConfig,
  isMatrixQaCliBackupUsable,
  type MatrixQaCliVerificationStatus,
} from "./scenario-runtime-e2ee-cli-shared.js";

export function assertMatrixQaCliE2eeStatus(
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

export function assertMatrixQaCliAccountAddBootstrapStatus(params: {
  expectedBackupVersion?: string | null;
  expectedUserId: string;
  status: MatrixQaCliVerificationStatus;
}) {
  const { expectedBackupVersion, expectedUserId, status } = params;
  if (status.encryptionEnabled !== true || status.recoveryKeyStored !== true) {
    throw new Error(
      "Matrix CLI account add --enable-e2ee degraded status did not keep encryption and recovery key state",
    );
  }
  if (status.userId !== expectedUserId) {
    throw new Error(
      `Matrix CLI account add --enable-e2ee status user mismatch: expected ${expectedUserId}, got ${status.userId ?? "<none>"}`,
    );
  }
  if (!status.deviceId || status.serverDeviceKnown !== true) {
    throw new Error(
      "Matrix CLI account add --enable-e2ee degraded status did not resolve the current server-known device",
    );
  }
  if (expectedBackupVersion && status.backupVersion !== expectedBackupVersion) {
    throw new Error(
      `Matrix CLI account add --enable-e2ee backup version mismatch: expected ${expectedBackupVersion}, got ${status.backupVersion ?? "<none>"}`,
    );
  }
  if (status.backup?.keyLoadError) {
    throw new Error(
      `Matrix CLI account add --enable-e2ee degraded status reported backup key error: ${status.backup.keyLoadError}`,
    );
  }
}

export async function runMatrixQaCliExpectedFailure(params: {
  args: string[];
  start: (args: string[], timeoutMs?: number) => MatrixQaCliSession;
  stdin?: string;
  timeoutMs: number;
}): Promise<MatrixQaCliRunResult> {
  const session = params.start(params.args, params.timeoutMs);
  try {
    if (params.stdin !== undefined) {
      await session.writeStdin(params.stdin);
      session.endStdin();
    }
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

export function buildMatrixQaCliE2eeAccountConfig(params: {
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

export async function readMatrixQaCliConfig(pathname: string): Promise<{
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
