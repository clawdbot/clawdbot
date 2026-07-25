import type { resolvePnpmRunner } from "./pnpm-runner.mjs";

type Getuid = typeof process.getuid;
type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => { error?: Error; status: number | null };
type ChromiumInstallOptions = {
  comSpec?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  existsSync?: (path: string) => boolean;
  getuid?: Getuid;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  spawnSync?: SpawnSyncLike;
  stdio?: "ignore" | "inherit" | "pipe";
};

export const systemChromiumExecutableCandidates: readonly string[];
export function canRunChromiumExecutable(
  executablePath: string,
  spawnSync?: SpawnSyncLike,
): boolean;
export function resolveSystemChromiumExecutablePath(
  existsSync?: (path: string) => boolean,
  spawnSync?: SpawnSyncLike,
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
