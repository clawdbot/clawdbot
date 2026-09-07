// Launches the TUI process with resolved environment and arguments.
import { spawn } from "node:child_process";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { filterOpenClawChildExecArgv } from "../infra/openclaw-cli-invocation.js";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import type { TuiOptions } from "./tui.js";

function appendOption(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) {
    return;
  }
  args.push(flag, String(value));
}

function buildCurrentCliEntryArgs(): string[] {
  const entry = process.argv[1]?.trim();
  if (!entry) {
    throw new Error("unable to relaunch TUI: current CLI entry path is unavailable");
  }
  return path.isAbsolute(entry) ? [entry] : [];
}

function buildTuiCliArgs(opts: TuiOptions): string[] {
  const args = [
    ...filterOpenClawChildExecArgv(process.execArgv),
    ...buildCurrentCliEntryArgs(),
    "tui",
  ];
  if (opts.local) {
    args.push("--local");
  }
  appendOption(args, "--url", opts.url);
  appendOption(args, "--token", opts.token);
  appendOption(args, "--password", opts.password);
  appendOption(args, "--tls-fingerprint", opts.tlsFingerprint);
  appendOption(args, "--session", opts.session);
  appendOption(args, "--thinking", opts.thinking);
  appendOption(args, "--message", opts.message);
  appendOption(args, "--timeout-ms", opts.timeoutMs);
  appendOption(args, "--history-limit", opts.historyLimit);
  if (opts.deliver) {
    args.push("--deliver");
  }
  return args;
}

/** Launches a child TUI process with inherited stdio. */
export async function launchTuiCli(opts: TuiOptions): Promise<void> {
  const args = buildTuiCliArgs(opts);
  // Pause parent stdin while the inherited-stdio child owns the terminal.
  // Keep it paused afterward so setup/container parents with stdin_open can exit.
  process.stdin.pause();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: process.env,
    });
    const { detach } = attachChildProcessBridge(child);

    child.on("error", (error) => {
      if (child.pid !== undefined) {
        return;
      }
      detach();
      reject(new Error(`failed to launch TUI: ${formatErrorMessage(error)}`));
    });

    child.once("exit", (code, signal) => {
      detach();
      if (signal) {
        reject(new Error(`TUI exited from signal ${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`TUI exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}
