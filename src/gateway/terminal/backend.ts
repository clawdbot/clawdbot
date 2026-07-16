import { spawnTerminalPty } from "../../process/terminal-pty.js";

export type TerminalBackendExit = {
  exitCode?: number;
  signal?: number;
  error?: string;
};

export interface TerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exit: TerminalBackendExit) => void): void;
}

export type LocalTerminalBackendSpawner = typeof spawnTerminalPty;

export async function createLocalTerminalBackend(
  params: Parameters<typeof spawnTerminalPty>[0],
  spawn: LocalTerminalBackendSpawner = spawnTerminalPty,
): Promise<TerminalBackend> {
  const pty = await spawn(params);
  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    kill: () => pty.kill(),
    onData: (callback) => pty.onData(callback),
    onExit: (callback) => pty.onExit(callback),
  };
}
