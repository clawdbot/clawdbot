#!/usr/bin/env node
import { spawnSync as spawnSyncImpl } from "node:child_process";
import { existsSync as existsSyncImpl, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightInstallArgs = ["--dir", "ui", "exec", "playwright", "install", "chromium"];
const executableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

export function resolveSystemChromiumExecutablePath(existsSync = existsSyncImpl) {
  return systemChromiumExecutableCandidates.find((candidate) => existsSync(candidate)) ?? "";
}

export function resolvePlaywrightInstallRunner(options = {}) {
  const env = options.env ?? process.env;
  return resolvePnpmRunner({
    comSpec: options.comSpec ?? env.ComSpec ?? env.COMSPEC,
    npmExecPath: env === process.env ? env.npm_execpath : (env.npm_execpath ?? ""),
    platform: options.platform,
    pnpmArgs: playwrightInstallArgs,
  });
}

export function isDirectScriptExecution(
  argvEntry = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  realpath = realpathSync.native,
) {
  if (!argvEntry) {
    return false;
  }
  try {
    return realpath(argvEntry) === realpath(modulePath);
  } catch {
    return resolve(argvEntry) === resolve(modulePath);
  }
}

export function ensurePlaywrightChromium(options = {}) {
  const env = options.env ?? process.env;
  const executableOverride =
    typeof env[executableOverrideEnvKey] === "string" ? env[executableOverrideEnvKey].trim() : "";
  const executablePath = options.executablePath ?? chromium.executablePath();
  const existsSync = options.existsSync ?? existsSyncImpl;
  const log = options.log ?? console.error;
  const spawnSync = options.spawnSync ?? spawnSyncImpl;

  if (executableOverride) {
    if (existsSync(executableOverride)) {
      return 0;
    }
    log(
      `[ui-e2e] ${executableOverrideEnvKey} points to ${executableOverride}, but that browser does not exist.`,
    );
    return 1;
  }

  if (existsSync(executablePath)) {
    return 0;
  }

  const systemExecutablePath =
    options.systemExecutablePath ?? resolveSystemChromiumExecutablePath(existsSync);
  if (systemExecutablePath) {
    log(`[ui-e2e] Using system Chromium at ${systemExecutablePath}.`);
    return 0;
  }

  if (env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1") {
    log(
      `[ui-e2e] Playwright Chromium is missing at ${executablePath}; OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 leaves the lane skipped.`,
    );
    return 0;
  }

  log(`[ui-e2e] Playwright Chromium is missing at ${executablePath}; installing chromium.`);
  const runner = resolvePlaywrightInstallRunner({
    comSpec: options.comSpec,
    env,
    platform: options.platform,
  });
  const result = spawnSync(runner.command, runner.args, {
    cwd: options.cwd ?? repoRoot,
    env,
    shell: runner.shell,
    stdio: options.stdio ?? "inherit",
    windowsVerbatimArguments: runner.windowsVerbatimArguments,
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    return status;
  }

  if (!existsSync(executablePath)) {
    log(
      `[ui-e2e] Playwright install completed but Chromium is still missing at ${executablePath}.`,
    );
    return 1;
  }
  return 0;
}

if (isDirectScriptExecution()) {
  process.exitCode = ensurePlaywrightChromium();
}
