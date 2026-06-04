/** Minimal ambient types for the @lydell/node-pty runtime dependency. */
declare module "@lydell/node-pty" {
  /** Exit event emitted by a PTY handle. */
  export type PtyExitEvent = { exitCode: number; signal?: number };
  /** Listener callback shape used by the PTY API. */
  export type PtyListener<T> = (event: T) => void;
  /** Spawned PTY handle used by terminal-backed runtimes. */
  export type PtyHandle = {
    pid: number;
    write: (data: string | Buffer) => void;
    onData: (listener: PtyListener<string>) => void;
    onExit: (listener: PtyListener<PtyExitEvent>) => void;
  };

  /** PTY spawn function signature consumed by OpenClaw. */
  export type PtySpawn = (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => PtyHandle;

  /** Spawn a PTY-backed child process. */
  export const spawn: PtySpawn;
}
