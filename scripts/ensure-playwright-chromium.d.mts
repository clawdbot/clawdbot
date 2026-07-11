import type { spawnSync, SpawnSyncOptions } from "node:child_process";
import type { existsSync } from "node:fs";
import type { resolvePnpmRunner } from "./pnpm-runner.mjs";

type Getuid = typeof process.getuid;
type ChromiumInstallOptions = {
  comSpec?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  existsSync?: typeof existsSync;
  getuid?: Getuid;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  spawnSync?: typeof spawnSync;
  stdio?: SpawnSyncOptions["stdio"];
};

export const systemChromiumExecutableCandidates: readonly string[];
export function canRunChromiumExecutable(
  executablePath: string,
  spawnSync?: typeof spawnSync,
): boolean;
export function resolveSystemChromiumExecutablePath(
  existsSync?: typeof existsSync,
  spawnSync?: typeof spawnSync,
): string;
export function resolvePlaywrightInstallRunner(options?: {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  targets?: string[];
  withDeps?: boolean;
}): ReturnType<typeof resolvePnpmRunner>;
export function shouldInstallPlaywrightSystemDependencies(options?: {
  env?: NodeJS.ProcessEnv;
  getuid?: Getuid;
  platform?: NodeJS.Platform;
}): boolean;
export function installLinuxSystemChromiumPackage(options?: ChromiumInstallOptions): number;
export function isDirectScriptExecution(
  argvEntry?: string,
  modulePath?: string,
  realpath?: (path: string) => string,
): boolean;
export function ensurePlaywrightChromium(
  options?: ChromiumInstallOptions & {
    ensureFfmpeg?: boolean;
    systemExecutablePath?: string;
  },
): number;
export function shouldEnsureFfmpegFromArgv(argv?: readonly string[]): boolean;
