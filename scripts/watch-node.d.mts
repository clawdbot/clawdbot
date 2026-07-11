export function resolveWatchLockPath(cwd: string, args?: string[]): string;
export function runWatchMain(params?: {
  spawn?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => {
    kill?: (signal?: NodeJS.Signals | number) => void;
    on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void;
  };
  createWatcher?: (
    paths: string[],
    options: {
      ignoreInitial: boolean;
      ignored: (watchPath: string) => boolean;
    },
  ) => {
    on: (event: "add" | "change" | "unlink" | "error", cb: (arg?: unknown) => void) => void;
    close?: () => Promise<void> | void;
  };
  loadChokidar?: () => Promise<{
    watch: (
      paths: string[],
      options: {
        ignoreInitial: boolean;
        ignored: (watchPath: string) => boolean;
      },
    ) => {
      on: (event: "add" | "change" | "unlink" | "error", cb: (arg?: unknown) => void) => void;
      close?: () => Promise<void> | void;
    };
  }>;
  watchPaths?: string[];
  process?: NodeJS.Process;
  cwd?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  lockDisabled?: boolean;
  killProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<number>;
