// Type declarations for repo scripts imported by tests without publishing them
// as normal TypeScript modules.
declare module "../../scripts/watch-node.mjs" {
  export function resolveWatchLockPath(cwd: string, args?: string[]): string;
  export function runWatchMain(params?: {
    spawn?: (
      cmd: string,
      args: string[],
      options: unknown,
    ) => { on: (event: "exit", cb: (code: number | null, signal: string | null) => void) => void };
    process?: NodeJS.Process;
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    fs?: { existsSync: (path: string) => boolean };
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
    lockDisabled?: boolean;
  }): Promise<number>;
}
