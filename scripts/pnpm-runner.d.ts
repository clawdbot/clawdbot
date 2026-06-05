// Pnpm Runner.D script supports OpenClaw repository automation.
import type { ChildProcess, SpawnOptions } from "node:child_process";

export type PnpmRunnerParams = {
  pnpmArgs?: string[];
  nodeArgs?: string[];
  npmExecPath?: string;
  nodeExecPath?: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
  cwd?: string;
  detached?: boolean;
  stdio?: SpawnOptions["stdio"];
  env?: NodeJS.ProcessEnv;
};

export function resolvePnpmRunner(params?: PnpmRunnerParams): {
  command: string;
  args: string[];
  shell: boolean;
  windowsVerbatimArguments?: boolean;
  env?: NodeJS.ProcessEnv;
};

export function createPnpmRunnerSpawnSpec(params?: PnpmRunnerParams): {
  command: string;
  args: string[];
  options: SpawnOptions;
};

export function spawnPnpmRunner(params?: PnpmRunnerParams): ChildProcess;
