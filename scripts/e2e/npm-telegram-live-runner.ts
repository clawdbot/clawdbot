// Telegram package Docker harness.
// Runs QA live transport code against the package candidate installed in Docker.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseBoolean(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveIntegerEnv(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

function resolveCredentialSource(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE ?? env.OPENCLAW_QA_CREDENTIAL_SOURCE;
}

function resolveCredentialRole(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE ?? env.OPENCLAW_QA_CREDENTIAL_ROLE;
}

function createRunId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resolvePackageTelegramOutputDir(env: NodeJS.ProcessEnv, repoRoot: string) {
  return (
    env.OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR?.trim() ||
    path.join(repoRoot, ".artifacts", "qa-e2e", `npm-telegram-live-${createRunId()}`)
  );
}

const DEFAULT_RTT_CHECK_ID = "telegram-mentioned-message-reply";

function resolveRttOptions(env: NodeJS.ProcessEnv, selectedScenarioIds: readonly string[] = []) {
  const explicitCheckIds = splitCsv(env.OPENCLAW_NPM_TELEGRAM_RTT_CHECKS);
  if (
    explicitCheckIds.length === 0 &&
    selectedScenarioIds.length > 0 &&
    !selectedScenarioIds.includes(DEFAULT_RTT_CHECK_ID)
  ) {
    return {};
  }
  const rttCount = parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES") ?? 20;
  return {
    rttCount,
    rttTimeoutMs: parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS"),
    maxRttFailures:
      parsePositiveIntegerEnv(env, "OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES") ?? rttCount,
    rttCheckIds: explicitCheckIds,
  };
}

async function shouldFailPackageTelegramRun(
  result: { summaryPath: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (parseBoolean(env.OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES)) {
    return false;
  }
  const { readQaSuiteFailedScenarioCountFromFile } =
    await import("../../extensions/qa-lab/src/suite-summary.ts");
  return (await readQaSuiteFailedScenarioCountFromFile(result.summaryPath)) > 0;
}

async function resolveTrustedOpenClawCommand(
  rawCommand: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!path.isAbsolute(rawCommand)) {
    throw new Error("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must be an absolute path.");
  }
  const commandName = path.basename(rawCommand);
  if (commandName !== "openclaw" && commandName !== "openclaw.cmd") {
    throw new Error(
      `OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must point to openclaw; got: ${commandName}`,
    );
  }
  const npmPrefix = env.NPM_CONFIG_PREFIX?.trim();
  if (!npmPrefix) {
    throw new Error("Missing NPM_CONFIG_PREFIX for installed openclaw command validation.");
  }
  const [realCommand, realPrefix] = await Promise.all([
    fs.realpath(rawCommand),
    fs.realpath(npmPrefix),
  ]);
  if (realCommand !== realPrefix && !realCommand.startsWith(`${realPrefix}${path.sep}`)) {
    throw new Error("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must resolve inside NPM_CONFIG_PREFIX.");
  }
  return {
    executablePath: rawCommand,
    usePackagedPlugins: true,
  } as const;
}

async function main() {
  const { runTelegramQaLive } =
    await import("../../extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts");
  const rawSutOpenClawCommand = process.env.OPENCLAW_NPM_TELEGRAM_SUT_COMMAND?.trim();
  if (!rawSutOpenClawCommand) {
    throw new Error("Missing OPENCLAW_NPM_TELEGRAM_SUT_COMMAND.");
  }
  const sutOpenClawCommand = await resolveTrustedOpenClawCommand(rawSutOpenClawCommand);

  const repoRoot = path.resolve(process.env.OPENCLAW_NPM_TELEGRAM_REPO_ROOT ?? process.cwd());
  const outputDir = resolvePackageTelegramOutputDir(process.env, repoRoot);
  const scenarioIds = splitCsv(process.env.OPENCLAW_NPM_TELEGRAM_SCENARIOS);
  const result = await runTelegramQaLive({
    env: process.env,
    repoRoot,
    outputDir,
    sutOpenClawCommand,
    providerMode: process.env.OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE,
    primaryModel: process.env.OPENCLAW_NPM_TELEGRAM_MODEL,
    alternateModel: process.env.OPENCLAW_NPM_TELEGRAM_ALT_MODEL,
    fastMode: parseBoolean(process.env.OPENCLAW_NPM_TELEGRAM_FAST),
    scenarioIds,
    ...resolveRttOptions(process.env, scenarioIds),
    sutAccountId: process.env.OPENCLAW_NPM_TELEGRAM_SUT_ACCOUNT,
    credentialSource: resolveCredentialSource(process.env),
    credentialRole: resolveCredentialRole(process.env),
  });

  process.stdout.write(`Package Telegram QA report: ${result.reportPath}\n`);
  process.stdout.write(`Package Telegram QA summary: ${result.summaryPath}\n`);
  if (await shouldFailPackageTelegramRun(result)) {
    process.exitCode = 1;
  }
}

async function formatRunnerErrorMessage(error: unknown) {
  try {
    const { formatErrorMessage } = await import("../../dist/infra/errors.js");
    return formatErrorMessage(error);
  } catch {
    return error instanceof Error ? error.message : String(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error: unknown) => {
    process.stderr.write(
      `package telegram live e2e failed: ${await formatRunnerErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export const testing = {
  parsePositiveIntegerEnv,
  resolvePackageTelegramOutputDir,
  resolveCredentialRole,
  resolveCredentialSource,
  resolveRttOptions,
  resolveTrustedOpenClawCommand,
  shouldFailPackageTelegramRun,
};
export { testing as __testing };
