#!/usr/bin/env -S node --import tsx

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runTelegramQaLive } from "../../extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts";
import { formatErrorMessage } from "../../src/infra/errors.ts";

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

function resolveCredentialSource(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE ?? env.OPENCLAW_QA_CREDENTIAL_SOURCE;
}

function resolveCredentialRole(env: NodeJS.ProcessEnv) {
  return env.OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE ?? env.OPENCLAW_QA_CREDENTIAL_ROLE;
}

async function resolveTrustedOpenClawCommand(rawCommand: string) {
  if (!path.isAbsolute(rawCommand)) {
    throw new Error("OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must be an absolute path.");
  }
  const commandName = path.basename(rawCommand);
  if (commandName !== "openclaw" && commandName !== "openclaw.cmd") {
    throw new Error(
      `OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must point to openclaw; got: ${commandName}`,
    );
  }
  const npmPrefix = process.env.NPM_CONFIG_PREFIX?.trim();
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
  return rawCommand;
}

async function main() {
  const rawSutOpenClawCommand = process.env.OPENCLAW_NPM_TELEGRAM_SUT_COMMAND?.trim();
  if (!rawSutOpenClawCommand) {
    throw new Error("Missing OPENCLAW_NPM_TELEGRAM_SUT_COMMAND.");
  }
  const sutOpenClawCommand = await resolveTrustedOpenClawCommand(rawSutOpenClawCommand);

  const repoRoot = path.resolve(process.env.OPENCLAW_NPM_TELEGRAM_REPO_ROOT ?? process.cwd());
  const outputDir =
    process.env.OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR?.trim() ||
    path.join(repoRoot, ".artifacts", "qa-e2e", `npm-telegram-live-${Date.now().toString(36)}`);
  const result = await runTelegramQaLive({
    repoRoot,
    outputDir,
    sutOpenClawCommand,
    preflightInstalledOnboarding: true,
    providerMode: process.env.OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE,
    primaryModel: process.env.OPENCLAW_NPM_TELEGRAM_MODEL,
    alternateModel: process.env.OPENCLAW_NPM_TELEGRAM_ALT_MODEL,
    fastMode: parseBoolean(process.env.OPENCLAW_NPM_TELEGRAM_FAST),
    scenarioIds: splitCsv(process.env.OPENCLAW_NPM_TELEGRAM_SCENARIOS),
    sutAccountId: process.env.OPENCLAW_NPM_TELEGRAM_SUT_ACCOUNT,
    credentialSource: resolveCredentialSource(process.env),
    credentialRole: resolveCredentialRole(process.env),
  });

  process.stdout.write(`NPM Telegram QA report: ${result.reportPath}\n`);
  process.stdout.write(`NPM Telegram QA summary: ${result.summaryPath}\n`);
  process.stdout.write(`NPM Telegram QA observed messages: ${result.observedMessagesPath}\n`);
  if (
    !parseBoolean(process.env.OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES) &&
    result.scenarios.some((scenario) => scenario.status === "fail")
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`npm telegram live e2e failed: ${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

export const __testing = {
  resolveCredentialRole,
  resolveCredentialSource,
};
