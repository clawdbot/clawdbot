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
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
    lockDisabled?: boolean;
  }): Promise<number>;
}

declare module "../../scripts/ci-changed-scope.mjs" {
  export function detectChangedScope(paths: string[]): {
    runNode: boolean;
    runMacos: boolean;
    runAndroid: boolean;
    runWindows: boolean;
    runSkillsPython: boolean;
    runChangedSmoke: boolean;
    runControlUiI18n: boolean;
  };
  export function detectInstallSmokeScope(paths: string[]): {
    runFastInstallSmoke: boolean;
    runFullInstallSmoke: boolean;
  };
}
