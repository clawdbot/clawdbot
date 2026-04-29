export function resolveGatewayWatchTmuxSessionName(params?: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}): string;

export function buildGatewayWatchTmuxCommand(params?: {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  sessionName?: string;
}): string;

export function runGatewayWatchTmuxMain(params?: {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  sessionName?: string;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    error?: NodeJS.ErrnoException;
    signal?: NodeJS.Signals | null;
    status?: number | null;
    stderr?: string;
    stdout?: string;
  };
  stderr?: { write: (message: string) => void };
  stdinIsTTY?: boolean;
  stdout?: { write: (message: string) => void };
  stdoutIsTTY?: boolean;
}): number;
