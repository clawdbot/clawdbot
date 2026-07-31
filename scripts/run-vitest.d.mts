import type { ChildProcess, SpawnOptions } from "node:child_process";
type VitestFs = {
  existsSync(path: string): boolean;
  symlinkSync?(target: string, path: string, type: string): void;
};

export const DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS: 120000;
export const DEFAULT_VITEST_NO_OUTPUT_HEARTBEAT_MS: 30000;
export const DEFAULT_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS: 300000;
export const DEFAULT_EXTRA_LONG_RUNNING_VITEST_NO_OUTPUT_TIMEOUT_MS: 2400000;
export const VITEST_CONFIG_NO_OUTPUT_TIMEOUT_MS: Map<string, number>;
export const TOOLING_EXCLUDED_TESTS: Set<string>;

export function resolveVitestNodeArgs(env?: NodeJS.ProcessEnv): string[];
export function resolveMissingVitestDependencyMessage(baseDir?: string, fsImpl?: VitestFs): string;
export function resolveVitestCliEntry(params?: {
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  fsImpl?: VitestFs;
  platform?: NodeJS.Platform;
  requireResolve?: (specifier: string, options?: { paths?: string[] }) => string;
}): string;
export function resolveVitestNoOutputTimeoutMs(env?: NodeJS.ProcessEnv): number | null;
export function resolveVitestNoOutputHeartbeatMs(env?: NodeJS.ProcessEnv): number | null;
export function resolveRunVitestSpawnEnv(
  env?: NodeJS.ProcessEnv,
  argv?: string[],
): NodeJS.ProcessEnv;
export function resolveDefaultVitestNoOutputTimeoutMs(argv?: string[]): number;
export function resolveVitestSpawnParams(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): SpawnOptions & { env: NodeJS.ProcessEnv; detached: boolean; stdio: string[] };
export function shouldSuppressVitestStderrLine(line: string): boolean;
export function resolveDirectNodeVitestArgs(pnpmArgs: string[]): string[] | null;
export function resolveExplicitTestFileNoPassArgs(argv: string[]): string[];
export function resolveTestProjectsDelegationArgs(argv: string[], cwd?: string): string[] | null;
export function resolveMissingExplicitTestFiles(
  argv: string[],
  cwd?: string,
  fsImpl?: VitestFs,
): string[];
export function resolveImplicitVitestArgs(argv: string[], cwd?: string): string[];
export function installVitestNoOutputWatchdog(params: {
  streams?: Array<{ on(event: string, listener: (...args: unknown[]) => void): unknown } | null>;
  timeoutMs: number | null;
  heartbeatMs?: number | null;
  label?: string;
  forceKillAfterMs?: number;
  log?: (message: string) => void;
  onTimeout?: () => void;
  onForceKill?: () => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): () => void;
export function spawnWatchedVitestProcess(params: {
  pnpmArgs: string[];
  spawnParams: SpawnOptions;
  env: NodeJS.ProcessEnv;
  label?: string;
  onNoOutputTimeout?: () => void;
}): {
  child: ChildProcess;
  getForwardedSignal: () => NodeJS.Signals | null;
  teardown: () => void;
};
export function resolveTestProjectsRunnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function resolveTestProjectsRunnerSpawnParams(
  env: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): SpawnOptions & { env: NodeJS.ProcessEnv; detached: boolean; stdio: "inherit" };
export function runTestProjectsDelegation(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options?: { runnerPath?: string },
): ChildProcess;
