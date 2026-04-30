import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLowDiskSpaceWarning } from "../infra/disk-space.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { beginBundledRuntimeDepsInstall } from "./bundled-runtime-deps-activity.js";
import {
  BUNDLED_RUNTIME_DEPS_LOCK_DIR,
  withBundledRuntimeDepsFilesystemLock,
  withBundledRuntimeDepsFilesystemLockAsync,
} from "./bundled-runtime-deps-lock.js";
import {
  assertBundledRuntimeDepsInstalled,
  ensureNpmInstallExecutionManifest,
  isRuntimeDepsPlanMaterialized,
  removeLegacyRuntimeDepsManifest,
} from "./bundled-runtime-deps-materialization.js";
import {
  createBundledRuntimeDepsInstallArgs,
  createBundledRuntimeDepsInstallEnv,
  resolveBundledRuntimeDepsPackageManagerRunner,
  type BundledRuntimeDepsPackageManager,
  type BundledRuntimeDepsPackageManagerRunner,
} from "./bundled-runtime-deps-package-manager.js";
import { normalizeRuntimeDepSpecs } from "./bundled-runtime-deps-specs.js";

const BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS = 5_000;

export type BundledRuntimeDepsInstallParams = {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  warn?: (message: string) => void;
};

function withBundledRuntimeDepsInstallRootLock<T>(installRoot: string, run: () => T): T {
  return withBundledRuntimeDepsFilesystemLock(installRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR, run);
}

async function withBundledRuntimeDepsInstallRootLockAsync<T>(
  installRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  return await withBundledRuntimeDepsFilesystemLockAsync(
    installRoot,
    BUNDLED_RUNTIME_DEPS_LOCK_DIR,
    run,
  );
}

function replaceNodeModulesDir(targetDir: string, sourceDir: string): void {
  const parentDir = path.dirname(targetDir);
  const tempDir = fs.mkdtempSync(path.join(parentDir, ".openclaw-runtime-deps-copy-"));
  const stagedDir = path.join(tempDir, "node_modules");
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Stale temp dirs are swept at the next runtime-deps pass. Do not fail
      // a node_modules replacement on a transient cleanup race.
    }
  }
}

function shouldCleanBundledRuntimeDepsInstallExecutionRoot(params: {
  installRoot: string;
  installExecutionRoot: string;
}): boolean {
  const installRoot = path.resolve(params.installRoot);
  const installExecutionRoot = path.resolve(params.installExecutionRoot);
  return installExecutionRoot.startsWith(`${installRoot}${path.sep}`);
}

function formatBundledRuntimeDepsInstallError(result: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}): string {
  const output = [
    result.error?.message,
    result.signal ? `terminated by ${result.signal}` : null,
    result.stderr,
    result.stdout,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return output || "npm install failed";
}

function formatBundledRuntimeDepsInstallElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function emitBundledRuntimeDepsOutputProgress(
  chunk: Buffer,
  stream: "stdout" | "stderr",
  packageManager: BundledRuntimeDepsPackageManager,
  onProgress: ((message: string) => void) | undefined,
): void {
  if (!onProgress) {
    return;
  }
  const lines = chunk
    .toString("utf8")
    .split(/\r\n|\n|\r/u)
    .map((line) => sanitizeTerminalText(line).trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  for (const line of lines) {
    onProgress(`${packageManager} ${stream}: ${line}`);
  }
}

type BundledRuntimeDepsInstallContext = {
  installExecutionRoot: string;
  installSpecs: string[];
  installEnv: NodeJS.ProcessEnv;
  runner: BundledRuntimeDepsPackageManagerRunner;
  isolatedExecutionRoot: boolean;
  cleanInstallExecutionRoot: boolean;
};

function createBundledRuntimeDepsInstallContext(params: {
  installRoot: string;
  installExecutionRoot?: string;
  installSpecs: readonly string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): BundledRuntimeDepsInstallContext {
  const installExecutionRoot = params.installExecutionRoot ?? params.installRoot;
  const isolatedExecutionRoot =
    path.resolve(installExecutionRoot) !== path.resolve(params.installRoot);
  const cleanInstallExecutionRoot =
    isolatedExecutionRoot &&
    shouldCleanBundledRuntimeDepsInstallExecutionRoot({
      installRoot: params.installRoot,
      installExecutionRoot,
    });

  fs.mkdirSync(params.installRoot, { recursive: true });
  fs.mkdirSync(installExecutionRoot, { recursive: true });
  const diskWarning = createLowDiskSpaceWarning({
    targetPath: installExecutionRoot,
    purpose: "bundled plugin runtime dependency staging",
  });
  if (diskWarning) {
    params.warn?.(diskWarning);
  }
  ensureNpmInstallExecutionManifest(installExecutionRoot, params.installSpecs);
  const installEnv = createBundledRuntimeDepsInstallEnv(params.env, {
    cacheDir: path.join(installExecutionRoot, ".openclaw-npm-cache"),
  });
  const runner = resolveBundledRuntimeDepsPackageManagerRunner({
    installExecutionRoot,
    env: installEnv,
    npmArgs: createBundledRuntimeDepsInstallArgs(),
  });

  return {
    installExecutionRoot,
    installSpecs: normalizeRuntimeDepSpecs(params.installSpecs),
    installEnv,
    runner,
    isolatedExecutionRoot,
    cleanInstallExecutionRoot,
  };
}

function finalizeBundledRuntimeDepsInstall(params: {
  installRoot: string;
  context: BundledRuntimeDepsInstallContext;
}): void {
  const { context } = params;
  assertBundledRuntimeDepsInstalled(context.installExecutionRoot, context.installSpecs);
  if (context.isolatedExecutionRoot) {
    const stagedNodeModulesDir = path.join(context.installExecutionRoot, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(`${context.runner.packageManager} install did not produce node_modules`);
    }
    const targetNodeModulesDir = path.join(params.installRoot, "node_modules");
    replaceNodeModulesDir(targetNodeModulesDir, stagedNodeModulesDir);
    assertBundledRuntimeDepsInstalled(params.installRoot, context.installSpecs);
  }
  removeLegacyRuntimeDepsManifest(params.installRoot);
}

function cleanupBundledRuntimeDepsInstallContext(context: BundledRuntimeDepsInstallContext): void {
  if (context.cleanInstallExecutionRoot) {
    fs.rmSync(context.installExecutionRoot, { recursive: true, force: true });
  }
}

async function spawnBundledRuntimeDepsInstall(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageManager: BundledRuntimeDepsPackageManager;
  onProgress?: (message: string) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAtMs = Date.now();
    const heartbeat =
      params.onProgress &&
      setInterval(() => {
        params.onProgress?.(
          `${params.packageManager} install still running (${formatBundledRuntimeDepsInstallElapsed(Date.now() - startedAtMs)} elapsed)`,
        );
      }, BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS);
    heartbeat?.unref?.();
    const settle = (fn: () => void) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      fn();
    };
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      emitBundledRuntimeDepsOutputProgress(
        chunk,
        "stdout",
        params.packageManager,
        params.onProgress,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      emitBundledRuntimeDepsOutputProgress(
        chunk,
        "stderr",
        params.packageManager,
        params.onProgress,
      );
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(formatBundledRuntimeDepsInstallError({ error }))));
    });
    child.on("close", (status, signal) => {
      if (status === 0 && !signal) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(
          new Error(
            formatBundledRuntimeDepsInstallError({
              status,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            }),
          ),
        ),
      );
    });
  });
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): void {
  const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs ?? params.missingSpecs);
  if (installSpecs.length === 0) {
    return;
  }
  if (isRuntimeDepsPlanMaterialized(params.installRoot, installSpecs)) {
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return;
  }
  const context = createBundledRuntimeDepsInstallContext({
    installRoot: params.installRoot,
    installExecutionRoot: params.installExecutionRoot,
    installSpecs,
    env: params.env,
    warn: params.warn,
  });
  try {
    const result = spawnSync(context.runner.command, context.runner.args, {
      cwd: context.installExecutionRoot,
      encoding: "utf8",
      env: context.runner.env ?? context.installEnv,
      stdio: "pipe",
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(formatBundledRuntimeDepsInstallError(result));
    }
    finalizeBundledRuntimeDepsInstall({ installRoot: params.installRoot, context });
  } finally {
    cleanupBundledRuntimeDepsInstallContext(context);
  }
}

export async function installBundledRuntimeDepsAsync(params: {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs ?? params.missingSpecs);
  if (installSpecs.length === 0) {
    return;
  }
  if (isRuntimeDepsPlanMaterialized(params.installRoot, installSpecs)) {
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return;
  }
  const context = createBundledRuntimeDepsInstallContext({
    installRoot: params.installRoot,
    installExecutionRoot: params.installExecutionRoot,
    installSpecs,
    env: params.env,
    warn: params.warn,
  });
  try {
    params.onProgress?.(
      `Starting ${context.runner.packageManager} install for bundled plugin runtime deps: ${installSpecs.join(", ")}`,
    );
    await spawnBundledRuntimeDepsInstall({
      command: context.runner.command,
      args: context.runner.args,
      cwd: context.installExecutionRoot,
      env: context.runner.env ?? context.installEnv,
      packageManager: context.runner.packageManager,
      onProgress: params.onProgress,
    });
    finalizeBundledRuntimeDepsInstall({ installRoot: params.installRoot, context });
  } finally {
    cleanupBundledRuntimeDepsInstallContext(context);
  }
}

export function repairBundledRuntimeDepsInstallRoot(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
  warn?: (message: string) => void;
}): { installSpecs: string[] } {
  return withBundledRuntimeDepsInstallRootLock(params.installRoot, () => {
    const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs);
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: installSpecs,
      installSpecs,
    });
    ensureNpmInstallExecutionManifest(params.installRoot, installSpecs);
    try {
      install({
        installRoot: params.installRoot,
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return { installSpecs };
  });
}

export async function repairBundledRuntimeDepsInstallRootAsync(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => Promise<void>;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<{ installSpecs: string[] }> {
  return await withBundledRuntimeDepsInstallRootLockAsync(params.installRoot, async () => {
    const installSpecs = normalizeRuntimeDepSpecs(params.installSpecs);
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDepsAsync({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
          onProgress: params.onProgress,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: installSpecs,
      installSpecs,
    });
    removeLegacyRuntimeDepsManifest(params.installRoot);
    ensureNpmInstallExecutionManifest(params.installRoot, installSpecs);
    try {
      await install({
        installRoot: params.installRoot,
        missingSpecs: installSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    removeLegacyRuntimeDepsManifest(params.installRoot);
    return { installSpecs };
  });
}
