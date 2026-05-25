export type NpmRunnerParams = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (path: string) => boolean;
  npmArgs?: string[];
  platform?: NodeJS.Platform;
};

export function resolveNpmRunner(params?: NpmRunnerParams): {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};
