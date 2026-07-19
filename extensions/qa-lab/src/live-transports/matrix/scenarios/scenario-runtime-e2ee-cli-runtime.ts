// Qa Matrix plugin module implements CLI runtime setup for E2EE scenarios.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { runMatrixQaOpenClawCli, startMatrixQaOpenClawCli } from "./scenario-runtime-cli.js";
import {
  assertMatrixQaPrivatePathMode,
  buildMatrixQaEmptyMatrixCliConfig,
} from "./scenario-runtime-e2ee-cli-shared.js";
import {
  requireMatrixQaCliRuntimeEnv,
  requireMatrixQaE2eeOutputDir,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";

export async function createMatrixQaCliSelfVerificationRuntime(params: {
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
    OPENCLAW_NO_AUTO_UPDATE: "1",
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

export async function createMatrixQaCliE2eeSetupRuntime(params: {
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
    OPENCLAW_NO_AUTO_UPDATE: "1",
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

export async function createMatrixQaCliGatewayRuntime(params: {
  artifactLabel: string;
  context: MatrixQaScenarioContext;
}) {
  const outputDir = requireMatrixQaE2eeOutputDir(params.context);
  const artifactDir = path.join(
    outputDir,
    params.artifactLabel,
    randomUUID().replaceAll("-", "").slice(0, 12),
  );
  await mkdir(artifactDir, { mode: 0o700, recursive: true });
  await chmod(artifactDir, 0o700).catch(() => undefined);
  await assertMatrixQaPrivatePathMode(artifactDir, "Matrix QA CLI artifact directory");
  const env = {
    ...requireMatrixQaCliRuntimeEnv(params.context),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
  const run = async (args: string[], timeoutMs = params.context.timeoutMs) =>
    await runMatrixQaOpenClawCli({
      args,
      env,
      timeoutMs,
    });
  return {
    dispose: async () => undefined,
    rootDir: artifactDir,
    run,
  };
}
