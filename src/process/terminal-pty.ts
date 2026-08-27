import path from "node:path";
import type { IPty } from "@lydell/node-pty";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { signalPtySessionTree } from "./kill-tree.js";
import {
  readPtyTerminalName,
  resolvePtyTerminalName,
  setPtyTerminalName,
} from "./pty-terminal-name.js";
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

function resolveTerminalNodeExecutable(env: NodeJS.ProcessEnv): string {
  // Packaged OpenClaw/Bun hosts cannot interpret npm's JavaScript entrypoint.
  // Use the running binary only when it is Node; otherwise require PATH node.exe.
  const candidate =
    path.win32.basename(process.execPath).toLowerCase() === "node.exe"
      ? process.execPath
      : resolveWindowsExecutablePath("node", env);
  if (path.win32.basename(candidate).toLowerCase() === "node.exe") {
    return candidate;
  }
  throw new Error(
    "A Node executable is required to launch this Windows npm wrapper; add node.exe to PATH.",
  );
}

function resolveTerminalPtyInvocation(params: {
  file: string;
  args: string[];
  platform?: NodeJS.Platform;
  comSpec?: string;
  env: NodeJS.ProcessEnv;
}): { file: string; args: string[] } {
  const platform = params.platform ?? process.platform;
  if (!isWindowsBatchCommand(params.file, platform)) {
    return { file: params.file, args: params.args };
  }
  const program = resolveWindowsSpawnProgram({
    command: params.file,
    platform,
    env: params.env,
    execPath: process.execPath,
    allowShellFallback: true,
  });
  if (program.resolution !== "shell-fallback") {
    const invocation = materializeWindowsSpawnProgram(
      program.resolution === "node-entrypoint"
        ? { ...program, command: resolveTerminalNodeExecutable(params.env) }
        : program,
      params.args,
    );
    return { file: invocation.command, args: invocation.argv };
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
  const terminalName = resolvePtyTerminalName(readPtyTerminalName(env, process.platform));
  setPtyTerminalName({ env, name: terminalName, platform: process.platform });
  const comSpec = resolveEnvironmentValue(env, "COMSPEC");
  const invocation = resolveTerminalPtyInvocation({
    file: params.file,
    args: params.args,
    env,
    ...(comSpec ? { comSpec } : {}),
  });
  const pty = spawn(invocation.file, invocation.args, {
    name: terminalName,
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
      // forkpty creates a new session/process group; retain descendant cleanup
      // after the shell exits and only its group remains.
      signalPtySessionTree(pty.pid, sig);
    } else if (process.platform === "win32") {
      pty.kill();
    } else {
      pty.kill(sig);
    }
  } catch {
    // Process may already be gone; teardown is best-effort.
  }
}
