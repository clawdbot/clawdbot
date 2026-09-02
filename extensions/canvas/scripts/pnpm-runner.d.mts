export interface PnpmRunnerParams {
  comSpec?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: string;
  pnpmArgs?: string[];
}

export interface PnpmRunnerSpec {
  args: string[];
  command: string;
  shell: false;
  windowsVerbatimArguments?: true;
}

export function resolvePnpmRunner(params?: PnpmRunnerParams): PnpmRunnerSpec;
