import type { ChildProcess, SpawnOptions } from "node:child_process";

export type PnpmRunnerParams = {
  comSpec?: string;
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
  pnpmArgs?: string[];
  stdio?: SpawnOptions["stdio"];
};

export function resolvePnpmRunner(params?: PnpmRunnerParams): {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};

export function createPnpmRunnerSpawnSpec(params?: PnpmRunnerParams): {
  args: string[];
  command: string;
  options: SpawnOptions;
};

export function spawnPnpmRunner(params?: PnpmRunnerParams): ChildProcess;
