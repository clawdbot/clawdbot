import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { QaGatewayChildCommand } from "../../gateway-child.js";
import { runQaFlowSuiteFromRuntime } from "../../suite-launch.runtime.js";
import type { QaSuiteRoundTripProbe } from "../../suite-round-trip.js";
import { readQaSuiteFailedScenarioCountFromFile } from "../../suite-summary.js";
// Qa Lab plugin module implements cli behavior.
import { printLiveTransportQaArtifacts } from "../shared/live-artifacts.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaRunOptions } from "../shared/live-transport-cli.runtime.js";
import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";
import { listTelegramQaScenarios, resolveTelegramQaScenarioIds } from "./profiles.js";

const TELEGRAM_QA_SUT_OPENCLAW_COMMAND_ENV = "OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND";
const TELEGRAM_QA_SUT_UID_ENV = "OPENCLAW_QA_TELEGRAM_SUT_UID";
const TELEGRAM_QA_SUT_GID_ENV = "OPENCLAW_QA_TELEGRAM_SUT_GID";
const TELEGRAM_QA_SUT_BOUNDARY_DIR_ENV = "OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR";
const TELEGRAM_QA_SUT_CLEANUP_TIMEOUT_ENV = "OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS";
const TELEGRAM_QA_SUT_RUNTIME_EXECUTABLE_ENV = "OPENCLAW_QA_TELEGRAM_SUT_RUNTIME_EXECUTABLE";
const TELEGRAM_QA_SUT_PRELOAD_PATH_ENV = "OPENCLAW_QA_TELEGRAM_SUT_PRELOAD_PATH";
const TELEGRAM_QA_SUT_FORWARDED_ENV_KEYS_ENV = "OPENCLAW_QA_TELEGRAM_SUT_FORWARDED_ENV_KEYS";

function parseSutId(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function parseForwardedEnvKeys(env: NodeJS.ProcessEnv) {
  const value = env[TELEGRAM_QA_SUT_FORWARDED_ENV_KEYS_ENV]?.trim();
  const keys =
    value
      ?.split(",")
      .map((key) => key.trim())
      .filter(Boolean) ?? [];
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error(
      `${TELEGRAM_QA_SUT_FORWARDED_ENV_KEYS_ENV} must contain unique comma-separated names.`,
    );
  }
  for (const key of keys) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`${TELEGRAM_QA_SUT_FORWARDED_ENV_KEYS_ENV} contains an invalid name.`);
    }
  }
  return keys;
}

async function resolveRegularPath(params: {
  env: NodeJS.ProcessEnv;
  key: string;
  executable?: boolean;
}) {
  const value = params.env[params.key]?.trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${params.key} must be an absolute file path.`);
  }
  try {
    const stats = await fs.lstat(value);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("configured path is not a regular file");
    }
    if (params.executable) {
      await fs.access(value, fsConstants.X_OK);
    }
  } catch (error) {
    const expected = params.executable ? "an executable regular file" : "a regular file";
    throw new Error(`${params.key} must point to ${expected}: ${value}`, { cause: error });
  }
  return value;
}

async function resolveTelegramQaSutOpenClawCommand(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QaGatewayChildCommand | undefined> {
  const configuredCommand = env[TELEGRAM_QA_SUT_OPENCLAW_COMMAND_ENV];
  if (configuredCommand === undefined) {
    return undefined;
  }
  const command = await resolveRegularPath({
    env,
    key: TELEGRAM_QA_SUT_OPENCLAW_COMMAND_ENV,
    executable: true,
  });
  const runtimeExecutablePath = await resolveRegularPath({
    env,
    key: TELEGRAM_QA_SUT_RUNTIME_EXECUTABLE_ENV,
    executable: true,
  });
  const preloadPath = await resolveRegularPath({
    env,
    key: TELEGRAM_QA_SUT_PRELOAD_PATH_ENV,
  });
  const tempParentDir = path.join(path.dirname(preloadPath), "tmp");
  const tempParentStats = await fs.lstat(tempParentDir);
  if (!tempParentStats.isDirectory() || tempParentStats.isSymbolicLink()) {
    throw new Error("Telegram SUT temp parent must be a regular directory.");
  }
  const runtimeEntryPath = path.join(repoRoot, "dist", "index.js");
  try {
    const runtimeEntryStats = await fs.lstat(runtimeEntryPath);
    if (!runtimeEntryStats.isFile() || runtimeEntryStats.isSymbolicLink()) {
      throw new Error("candidate runtime entry is not a regular file");
    }
  } catch (error) {
    throw new Error(`Telegram SUT runtime entry is invalid: ${runtimeEntryPath}`, { cause: error });
  }
  const evidenceDir = env[TELEGRAM_QA_SUT_BOUNDARY_DIR_ENV]?.trim();
  if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
    throw new Error(`${TELEGRAM_QA_SUT_BOUNDARY_DIR_ENV} must be an absolute directory path.`);
  }
  const evidenceStats = await fs.lstat(evidenceDir);
  if (!evidenceStats.isDirectory() || evidenceStats.isSymbolicLink()) {
    throw new Error(`${TELEGRAM_QA_SUT_BOUNDARY_DIR_ENV} must point to a regular directory.`);
  }
  return {
    executablePath: command,
    tempParentDir,
    usePackagedPlugins: true,
    processBoundary: {
      kind: "linux-proc-v1",
      evidenceDir,
      expectedUid: parseSutId(env, TELEGRAM_QA_SUT_UID_ENV),
      expectedGid: parseSutId(env, TELEGRAM_QA_SUT_GID_ENV),
      forwardedEnvKeys: parseForwardedEnvKeys(env),
      runtimeExecutablePath,
      runtimeArgsPrefix: ["--import", preloadPath, runtimeEntryPath],
      terminationRetryTimeoutMs: parseSutId(env, TELEGRAM_QA_SUT_CLEANUP_TIMEOUT_ENV),
    },
  };
}

type TelegramQaSuiteOptions = LiveTransportQaCommandOptions & {
  roundTripProbe?: QaSuiteRoundTripProbe;
  sutOpenClawCommand?: QaGatewayChildCommand;
};

export async function runQaTelegramSuite(opts: TelegramQaSuiteOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  if (runOptions.listScenarios) {
    for (const scenario of listTelegramQaScenarios(runOptions.providerMode)) {
      const defaultLabel = scenario.defaultEnabled ? "default" : "optional";
      const refs =
        scenario.regressionRefs.length > 0 ? ` refs=${scenario.regressionRefs.join(",")}` : "";
      process.stdout.write(
        `${scenario.id}\t${defaultLabel}\t${scenario.title}\t${scenario.rationale}${refs}\n`,
      );
    }
    return undefined;
  }
  const scenarioIds = resolveTelegramQaScenarioIds({
    profile: opts.profile,
    providerMode: runOptions.providerMode,
    scenarioIds: runOptions.scenarioIds,
  });
  const result = await runQaFlowSuiteFromRuntime({
    adapterFactories: [
      {
        id: "telegram",
        matches: ({ channelId, driver }) => driver === "live" && channelId === "telegram",
        create: createTelegramQaTransportAdapter,
      },
    ],
    adapterOptions: {
      repoRoot: runOptions.repoRoot,
      ...(runOptions.credentialRole ? { credentialRole: runOptions.credentialRole } : {}),
      ...(runOptions.credentialSource ? { credentialSource: runOptions.credentialSource } : {}),
      ...(runOptions.sutAccountId ? { sutAccountId: runOptions.sutAccountId } : {}),
    },
    channelDriver: "live",
    channelId: "telegram",
    concurrency: 1,
    ...(runOptions.alternateModel ? { alternateModel: runOptions.alternateModel } : {}),
    ...(runOptions.fastMode !== undefined ? { fastMode: runOptions.fastMode } : {}),
    ...(runOptions.failFast !== undefined ? { failFast: runOptions.failFast } : {}),
    ...(runOptions.outputDir ? { outputDir: runOptions.outputDir } : {}),
    ...(runOptions.primaryModel ? { primaryModel: runOptions.primaryModel } : {}),
    providerMode: runOptions.providerMode,
    repoRoot: runOptions.repoRoot,
    roundTripProbe: opts.roundTripProbe,
    scenarioIds,
    sutOpenClawCommand: opts.sutOpenClawCommand,
  });
  printLiveTransportQaArtifacts("Telegram QA", {
    report: result.reportPath,
    summary: result.summaryPath,
  });
  if (!runOptions.allowFailures) {
    const failedScenarioCount = await readQaSuiteFailedScenarioCountFromFile(result.summaryPath);
    if (failedScenarioCount > 0) {
      process.exitCode = 1;
    }
  }
  return result;
}

export async function runQaTelegramCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  if (runOptions.listScenarios) {
    return await runQaTelegramSuite(opts);
  }
  resolveTelegramQaScenarioIds({
    profile: opts.profile,
    providerMode: runOptions.providerMode,
    scenarioIds: runOptions.scenarioIds,
  });
  const sutOpenClawCommand = await resolveTelegramQaSutOpenClawCommand(runOptions.repoRoot);
  return await runQaTelegramSuite({
    ...opts,
    ...(sutOpenClawCommand ? { sutOpenClawCommand } : {}),
  });
}
