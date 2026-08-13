#!/usr/bin/env node
// Ensures Playwright Chromium is installed or a usable system browser is available.
import { spawnSync as spawnSyncImpl } from "node:child_process";
import { existsSync as existsSyncImpl, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parsePermissiveBooleanToken } from "./lib/arg-utils.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { resolvePnpmRunner, type PnpmRunnerParams } from "./pnpm-runner.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const playwrightInstallBaseArgs = ["--dir", "ui", "exec", "playwright", "install"];
const executableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
const chromiumPackageNames = ["chromium-browser", "chromium"];
type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => { status: number | null };
type PnpmEnvironmentOptions = Pick<PnpmRunnerParams, "comSpec" | "env" | "platform">;
type ChromiumInstallOptions = PnpmEnvironmentOptions & {
  cwd?: string;
  ensureFfmpeg?: boolean;
  executablePath?: string;
  existsSync?: (path: string) => boolean;
  getuid?: () => number;
  log?: (message: string) => void;
  requirePlaywrightChromium?: boolean;
  spawnSync?: SpawnSyncLike;
  stdio?: "ignore" | "inherit" | "pipe";
  systemExecutablePath?: string;
};
type PlaywrightRunnerOptions = PnpmEnvironmentOptions & {
  targets?: string[];
  withDeps?: boolean;
};
/**
 * System Chromium executable paths used before downloading Playwright browsers.
 */
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

/**
 * Checks whether a Chromium executable can start enough to print its version.
 */
export function canRunChromiumExecutable(
  executablePath: string,
  spawnSync: SpawnSyncLike = spawnSyncImpl,
) {
  const result = spawnSync(executablePath, ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Resolves the first runnable system Chromium executable path.
 */
export function resolveSystemChromiumExecutablePath(
  existsSync: (path: string) => boolean = existsSyncImpl,
  spawnSync: SpawnSyncLike = spawnSyncImpl,
) {
  return (
    systemChromiumExecutableCandidates.find(
      (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate, spawnSync),
    ) ?? ""
  );
}

/**
 * Builds the pnpm runner invocation for Playwright browser install.
 */
export function resolvePlaywrightInstallRunner(options: PlaywrightRunnerOptions = {}) {
  const env = options.env ?? process.env;
  const targets = options.targets ?? ["chromium"];
  return resolvePnpmRunner({
    comSpec: options.comSpec,
    env,
    npmExecPath: env === process.env ? env.npm_execpath : (env.npm_execpath ?? ""),
    platform: options.platform,
    pnpmArgs: [
      ...playwrightInstallBaseArgs,
      ...(options.withDeps ? ["--with-deps"] : []),
      ...targets,
    ],
  });
}

/**
 * Reports whether Linux system dependencies should be installed with Chromium.
 */
export function shouldInstallPlaywrightSystemDependencies(
  options: Pick<ChromiumInstallOptions, "env" | "getuid" | "platform"> = {},
) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const getuid = options.getuid ?? process.getuid;
  if (platform !== "linux") {
    return false;
  }
  if (typeof getuid === "function" && getuid() === 0) {
    return true;
  }
  return (
    parsePermissiveBooleanToken(env.CI) === true ||
    parsePermissiveBooleanToken(env.GITHUB_ACTIONS) === true ||
    parsePermissiveBooleanToken(env.OPENCLAW_TESTBOX) === true
  );
}

function resolveLinuxPrivilegePrefix(
  options: Pick<ChromiumInstallOptions, "getuid" | "spawnSync"> = {},
) {
  const getuid = options.getuid ?? process.getuid;
  const spawnSync = options.spawnSync ?? spawnSyncImpl;
  if (typeof getuid === "function" && getuid() === 0) {
    return [];
  }
  const result = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" });
  if (result.status === 0) {
    return ["sudo", "-n"];
  }
  return undefined;
}

/**
 * Installs a distro Chromium package for CI images newer than Playwright's
 * bundled browser support matrix.
 */
export function installLinuxSystemChromiumPackage(options: ChromiumInstallOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return 1;
  }
  const spawnSync = options.spawnSync ?? spawnSyncImpl;
  const privilegePrefix = resolveLinuxPrivilegePrefix({
    getuid: options.getuid,
    spawnSync,
  });
  if (!privilegePrefix) {
    return 1;
  }
  const env = {
    ...(options.env ?? process.env),
    DEBIAN_FRONTEND: "noninteractive",
  };
  const cwd = options.cwd ?? repoRoot;
  const stdio = options.stdio ?? "inherit";
  const runAptGet = (args: string[]) => {
    const command = privilegePrefix[0] ?? "apt-get";
    const commandArgs =
      privilegePrefix.length === 0 ? args : [...privilegePrefix.slice(1), "apt-get", ...args];
    return (
      spawnSync(command, commandArgs, {
        cwd,
        env,
        stdio,
      }).status ?? 1
    );
  };

  const updateStatus = runAptGet(["update", "-qq"]);
  if (updateStatus !== 0) {
    return updateStatus;
  }
  for (const packageName of chromiumPackageNames) {
    const installStatus = runAptGet(["install", "-y", packageName]);
    if (installStatus === 0) {
      return 0;
    }
  }
  return 1;
}

/**
 * Checks whether this module is the direct script entrypoint.
 */
export function isDirectScriptExecution(
  argvEntry: string | undefined = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  realpath: (path: string) => string = realpathSync.native,
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

/**
 * Ensures a runnable Chromium exists for Playwright-based UI tests.
 */
export function ensurePlaywrightChromium(options: ChromiumInstallOptions = {}) {
  const env = options.env ?? process.env;
  const browserPath = env.PLAYWRIGHT_BROWSERS_PATH;
  // pnpm --dir ui changes the installer's cwd; keep its cache aligned with the caller.
  const installEnv =
    browserPath && browserPath !== "0" && !isAbsolute(browserPath)
      ? {
          ...env,
          PLAYWRIGHT_BROWSERS_PATH: resolve(
            env.INIT_CWD || options.cwd || process.cwd(),
            browserPath,
          ),
        }
      : env;
  const requirePlaywrightChromium = options.requirePlaywrightChromium ?? false;
  const executableOverride =
    typeof env[executableOverrideEnvKey] === "string" ? env[executableOverrideEnvKey].trim() : "";
  const executablePath = options.executablePath ?? chromium.executablePath();
  const existsSync = options.existsSync ?? existsSyncImpl;
  const log = options.log ?? console.error;
  const spawnSync = options.spawnSync ?? spawnSyncImpl;
  const runPlaywrightInstall = (targets: string[] = ["chromium"], withDeps = false) => {
    const runner = resolvePlaywrightInstallRunner({
      comSpec: options.comSpec,
      env: installEnv,
      platform: options.platform,
      targets,
      withDeps,
    });
    const result = spawnSync(runner.command, runner.args, {
      cwd: options.cwd ?? repoRoot,
      env: installEnv,
      shell: runner.shell,
      stdio: options.stdio ?? "inherit",
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    });
    return result.status ?? 1;
  };
  const useLinuxSystemChromiumPackage = () => {
    if (requirePlaywrightChromium) {
      log(`[ui-e2e] This lane requires Playwright-managed Chromium; refusing system fallback.`);
      return 1;
    }
    log(`[ui-e2e] Playwright install is unavailable; installing a system Chromium package.`);
    const installStatus = installLinuxSystemChromiumPackage({
      cwd: options.cwd,
      env,
      getuid: options.getuid,
      platform: options.platform,
      spawnSync,
      stdio: options.stdio,
    });
    if (installStatus !== 0) {
      log(`[ui-e2e] System Chromium package install failed with status ${installStatus}.`);
      return installStatus;
    }
    const installedSystemExecutablePath = resolveSystemChromiumExecutablePath(
      existsSync,
      spawnSync,
    );
    if (installedSystemExecutablePath) {
      log(`[ui-e2e] Using system Chromium at ${installedSystemExecutablePath}.`);
      return ensureFfmpeg();
    }
    log(`[ui-e2e] System Chromium package install completed but no runnable Chromium was found.`);
    return 1;
  };
  const ensureFfmpeg = () => {
    if (!options.ensureFfmpeg) {
      return 0;
    }
    const status = runPlaywrightInstall(["ffmpeg"]);
    if (status !== 0) {
      log(`[ui-e2e] Playwright ffmpeg install failed with status ${status}.`);
    }
    return status;
  };

  if (!requirePlaywrightChromium && executableOverride) {
    if (existsSync(executableOverride) && canRunChromiumExecutable(executableOverride, spawnSync)) {
      return ensureFfmpeg();
    }
    log(
      `[ui-e2e] ${executableOverrideEnvKey} points to ${executableOverride}, but that browser is not runnable.`,
    );
    return 1;
  }

  if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
    return ensureFfmpeg();
  }

  if (!requirePlaywrightChromium) {
    const systemExecutablePath =
      options.systemExecutablePath ?? resolveSystemChromiumExecutablePath(existsSync, spawnSync);
    if (systemExecutablePath && canRunChromiumExecutable(systemExecutablePath, spawnSync)) {
      log(`[ui-e2e] Using system Chromium at ${systemExecutablePath}.`);
      return ensureFfmpeg();
    }
  }

  if (env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1") {
    log(
      `[ui-e2e] Playwright Chromium is missing at ${executablePath}; OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 leaves the lane skipped.`,
    );
    return 0;
  }

  log(`[ui-e2e] Playwright Chromium is not runnable at ${executablePath}; installing chromium.`);
  const canInstallSystemDependencies = shouldInstallPlaywrightSystemDependencies({
    env,
    getuid: options.getuid,
    platform: options.platform,
  });
  const status = runPlaywrightInstall();
  if (status !== 0) {
    if (canInstallSystemDependencies) {
      log(
        `[ui-e2e] Chromium install failed in a Linux CI/root lane; installing Linux system dependencies.`,
      );
      const depsStatus = runPlaywrightInstall(["chromium"], true);
      if (depsStatus !== 0) {
        return useLinuxSystemChromiumPackage();
      }
      if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
        return ensureFfmpeg();
      }
      log(
        `[ui-e2e] Playwright install completed but Chromium is still not runnable at ${executablePath}.`,
      );
      return 1;
    }
    return status;
  }

  if (!existsSync(executablePath) || !canRunChromiumExecutable(executablePath, spawnSync)) {
    if (canInstallSystemDependencies) {
      log(
        `[ui-e2e] Chromium is installed but still cannot start; installing Linux system dependencies.`,
      );
      const depsStatus = runPlaywrightInstall(["chromium"], true);
      if (depsStatus !== 0) {
        return useLinuxSystemChromiumPackage();
      }
      if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
        return ensureFfmpeg();
      }
      return useLinuxSystemChromiumPackage();
    }
    log(
      `[ui-e2e] Playwright install completed but Chromium is still not runnable at ${executablePath}.`,
    );
    return 1;
  }
  return ensureFfmpeg();
}

export function shouldEnsureFfmpegFromArgv(argv: readonly string[] = process.argv) {
  return !argv.includes("--skip-ffmpeg");
}

export function shouldRequirePlaywrightChromiumFromArgv(argv: readonly string[] = process.argv) {
  return argv.includes("--require-playwright-chromium");
}

if (isDirectScriptExecution()) {
  process.exitCode = ensurePlaywrightChromium({
    ensureFfmpeg: shouldEnsureFfmpegFromArgv(),
    requirePlaywrightChromium: shouldRequirePlaywrightChromiumFromArgv(),
  });
}
