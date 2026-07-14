// Thin, resize-capable PTY wrapper for the operator terminal.
//
// The process supervisor's PTY adapter is shaped for one-shot managed runs and
// hides resize; the operator terminal needs a long-lived, interactive handle, so
// it owns this narrow loader instead of reshaping the supervisor contract.
import type { IPty } from "@lydell/node-pty";
import { signalProcessTree } from "../../process/kill-tree.js";

/** Live PTY handle used by one operator terminal session. */
export type TerminalPtyHandle = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (listener: (chunk: string) => void) => void;
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void;
  kill: (signal?: string) => void;
};

/** Spawns a PTY process and adapts it to the terminal session handle. */
export async function spawnTerminalPty(params: {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}): Promise<TerminalPtyHandle> {
  const { spawn } = await import("@lydell/node-pty");
  const pty = spawn(params.file, params.args, {
    name: params.env.TERM ?? "xterm-256color",
    cols: params.cols,
    rows: params.rows,
    cwd: params.cwd,
    env: params.env,
  });
  return {
    get pid() {
      return pty.pid;
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    kill: (signal) => killPtyTree(pty, signal),
  } satisfies TerminalPtyHandle;
}

// node-pty's kill only signals the shell; commands it launched (a long-running
// `npm install`, `sleep`, etc.) would survive close/disconnect/shutdown. Signal
// the whole process tree instead, mirroring the process supervisor's PTY adapter.
function killPtyTree(pty: Pick<IPty, "pid" | "kill">, signal?: string): void {
  const sig = (signal ?? "SIGKILL") as NodeJS.Signals;
  try {
    if ((sig === "SIGKILL" || sig === "SIGTERM") && typeof pty.pid === "number" && pty.pid > 0) {
      signalProcessTree(pty.pid, sig);
    } else if (process.platform === "win32") {
      pty.kill();
    } else {
      pty.kill(sig);
    }
  } catch {
    // Process may already be gone; teardown is best-effort.
  }
}
