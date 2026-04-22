export const runNodeWatchedPaths: string[];
export function isBuildRelevantRunNodePath(repoPath: string): boolean;
export function isRestartRelevantRunNodePath(repoPath: string): boolean;
export function resolveBuildRequirement(deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: unknown;
  spawnSync: unknown;
  distRoot: string;
  distEntry: string;
  buildStampPath: string;
  sourceRoots: Array<{ name: string; path: string }>;
  configFiles: string[];
}): { shouldBuild: boolean; reason: string };

export function resolveRuntimePostBuildRequirement(deps: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: unknown;
  spawnSync: unknown;
  buildStampPath: string;
  runtimePostBuildStampPath: string;
}): { shouldSync: boolean; reason: string };

export function acquireRunNodeBuildLock(deps: {
  cwd: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  fs: unknown;
  process: NodeJS.Process;
  stderr: { write: (value: string) => void };
}): Promise<() => void>;

export function runNodeMain(params?: {
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    kill?: (signal?: string) => boolean | void;
    on: (
      event: "exit",
      cb: (code: number | null, signal: string | null) => void,
    ) => void | undefined;
  };
  spawnSync?: unknown;
  fs?: unknown;
  stderr?: { write: (value: string) => void };
  process?: NodeJS.Process;
  execPath?: string;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<number>;
