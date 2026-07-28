/**
 * Builds the platform-specific oxlint shard list.
 */
export function createOxlintShards({
  cwd,
  env,
  platform,
  readDir,
  splitCore,
}?: {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  readDir?: ((target: string) => string[]) | undefined;
  splitCore?: boolean | undefined;
}): {
  name: string;
  args: string[];
}[];
/**
 * Chunks extension lint targets to avoid Windows command-line and memory limits.
 */
export function createWindowsExtensionShards({
  cwd,
  env,
  readDir,
}?: {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  readDir?: ((target: string) => string[]) | undefined;
}): {
  name: string;
  args: string[];
}[];
/**
 * Reads the Windows extension shard chunk size.
 */
export function resolveWindowsExtensionChunkSize(env?: NodeJS.ProcessEnv): unknown;
/**
 * Chooses serial shard execution for constrained hosts or Windows.
 */
export function shouldRunOxlintShardsSerial({
  env,
  platform,
  hostResources,
}?: {
  env?: NodeJS.ProcessEnv | undefined;
  hostResources?: { logicalCpuCount: number; totalMemoryBytes: number };
  platform?: NodeJS.Platform | undefined;
}): boolean;
/**
 * Runs selected oxlint shards and returns process-style success/failure.
 */
export function main(extraArgs?: string[], runtimeEnv?: NodeJS.ProcessEnv): Promise<void>;
/**
 * Parses shard-runner flags separately from forwarded oxlint args.
 */
export function parseShardRunnerArgs(args: string[]): {
  only: Set<string>;
  oxlintArgs: string[];
  splitCore: boolean;
};
/**
 * Filters shards by an optional comma-separated shard name list.
 */
export function filterOxlintShards<T extends { name: string }>(shards: T[], only: Set<string>): T[];
/**
 * Resolves shard concurrency from env, platform, and host resources.
 */
export function resolveOxlintShardConcurrency({
  env,
  platform,
  hostResources,
  splitCore,
}?: {
  env?: NodeJS.ProcessEnv | undefined;
  hostResources?: { logicalCpuCount: number; totalMemoryBytes: number };
  platform?: NodeJS.Platform | undefined;
  splitCore?: boolean | undefined;
}): number;
/**
 * Runs one oxlint shard with bounded output, heartbeat, and forced cleanup.
 */
export function runShard({
  env,
  extraArgs,
  runner,
  shard,
}: {
  env: unknown;
  extraArgs: unknown;
  runner: unknown;
  shard: unknown;
}): Promise<unknown>;
/**
 * Reads the shard heartbeat interval.
 */
export function resolveShardHeartbeatMs(env: unknown): unknown;
/**
 * Reads the per-shard timeout.
 */
export function resolveShardTimeoutMs(env: unknown): unknown;
/**
 * Reads the graceful shutdown window before SIGKILL.
 */
export function resolveShardKillGraceMs(env: unknown): unknown;
