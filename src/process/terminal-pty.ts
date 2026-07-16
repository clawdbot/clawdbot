import type { IPty } from "@lydell/node-pty";
import { signalProcessTree } from "./kill-tree.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
} from "./windows-command.js";

/** Live PTY handle shared by gateway terminals and node-host commands. */
type TerminalPtyHandle = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
};

function resolveTerminalPtyInvocation(params: {
  file: string;
  args: string[];
  platform?: NodeJS.Platform;
  comSpec?: string;
}): { file: string; args: string[] } {
  const platform = params.platform ?? process.platform;
  if (!isWindowsBatchCommand(params.file, platform)) {
    return { file: params.file, args: params.args };
  }
  return {
    file: params.comSpec?.trim() || resolveTrustedWindowsCmdExe(platform),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(params.file, params.args)],
  };
}

export async function spawnTerminalPty(params: {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}): Promise<TerminalPtyHandle> {
  const { spawn } = await import("@lydell/node-pty");
  const env = { ...params.env };
  // Ambient TERM=dumb describes the gateway/node host, not this real PTY.
  // Passing it through makes interactive CLIs refuse to start in the web terminal.
  const inheritedTerm = env.TERM?.trim();
  env.TERM =
    !inheritedTerm || inheritedTerm.toLowerCase() === "dumb" ? "xterm-256color" : inheritedTerm;
  const comSpec = env.ComSpec ?? env.COMSPEC;
  const invocation = resolveTerminalPtyInvocation({
    file: params.file,
    args: params.args,
    ...(comSpec ? { comSpec } : {}),
  });
  const pty = spawn(invocation.file, invocation.args, {
    name: env.TERM,
    cols: params.cols,
    rows: params.rows,
    cwd: params.cwd,
    env,
  });
  return {
    get pid() {
      return pty.pid;
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    kill: (signal) => killPtyTree(pty, signal),
  } satisfies TerminalPtyHandle;
}

// A long-running child of the interactive shell must not survive terminal
// close. Signal the process tree, matching the process supervisor contract.
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
