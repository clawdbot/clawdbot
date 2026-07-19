/** Return whether local-heavy-check safeguards are enabled for an environment. */
export type LocalHostResources = {
  logicalCpuCount: number;
  totalMemoryBytes: number;
};
export function isLocalCheckEnabled(env: NodeJS.ProcessEnv): boolean;
/** Ensure local check runs opt into safeguard environment outside CI. */
export function resolveLocalHeavyCheckEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Resolve a repo tool from this worktree or the primary checkout's installed toolchain. */
export function resolveRepoToolBinPath(
  toolName: string,
  options?: {
    cwd?: string;
    fileExists?: (candidate: string) => boolean;
    resolveCommonDir?: (cwd: string) => string | null;
  },
): string;
/** Apply local tsgo defaults for declaration skipping, caching, throttling, and profiling. */
export function applyLocalTsgoPolicy(
  args: string[],
  env: NodeJS.ProcessEnv,
  hostResources: LocalHostResources,
): {
  env: NodeJS.ProcessEnv;
  args: string[];
};
/** Apply local oxlint defaults for type-aware checking and throttled worker settings. */
export function applyLocalOxlintPolicy(
  args: string[],
  env: NodeJS.ProcessEnv,
  hostResources: LocalHostResources,
): {
  env: NodeJS.ProcessEnv;
  args: string[];
};
/** Decide whether an oxlint invocation needs the local heavy-check lock. */
export function shouldAcquireLocalHeavyCheckLockForOxlint(
  args: string[],
  {
    cwd,
    env,
  }?: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
  },
): boolean;
/** Decide whether a tsgo invocation needs the local heavy-check lock. */
export function shouldAcquireLocalHeavyCheckLockForTsgo(
  args: string[],
  env?: NodeJS.ProcessEnv,
): boolean;
/** Acquire a filesystem lock for one local heavy check and return its release callback. */
export function acquireLocalHeavyCheckLockSync(params: unknown): () => void;
