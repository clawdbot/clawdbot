import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeEnv } from "../runtime.js";

export type SignalDaemonOpts = {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: RuntimeEnv;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
};

/**
 * Setup Signal data directory for containerized environments.
 * Auto-detects persistent storage and creates symlink if needed.
 *
 * Priority order:
 * 1. SIGNAL_CLI_DATA_DIR env var (if set)
 * 2. /data/.local/share/signal-cli (Fly.io convention)
 * 3. /var/lib/clawdbot/.local/share/signal-cli (alternative persistent location)
 * 4. Default: ~/.local/share/signal-cli (no symlink needed)
 */
export function setupSignalDataPersistence(runtime?: RuntimeEnv): void {
  const log = runtime?.log ?? (() => {});
  const defaultPath = join(homedir(), ".local", "share", "signal-cli");

  // Check if already a symlink or regular directory exists
  if (existsSync(defaultPath)) {
    try {
      const stats = lstatSync(defaultPath);
      if (stats.isSymbolicLink()) {
        log(`signal-cli data already symlinked to persistent storage`);
        return;
      }
      // Regular directory exists, don't touch it
      return;
    } catch {
      // Ignore errors, will try to create below
    }
  }

  // Determine persistent storage location
  let persistentPath: string | null = null;

  // Priority 1: Environment variable
  if (process.env.SIGNAL_CLI_DATA_DIR) {
    persistentPath = process.env.SIGNAL_CLI_DATA_DIR;
    log(`signal-cli: using SIGNAL_CLI_DATA_DIR=${persistentPath}`);
  }
  // Priority 2: /data (Fly.io convention)
  else if (existsSync("/data")) {
    persistentPath = "/data/.local/share/signal-cli";
  }
  // Priority 3: /var/lib/clawdbot
  else if (existsSync("/var/lib/clawdbot")) {
    persistentPath = "/var/lib/clawdbot/.local/share/signal-cli";
  }

  // No persistent storage detected, use default
  if (!persistentPath) {
    return;
  }

  // Create persistent directory structure
  try {
    mkdirSync(persistentPath, { recursive: true });
    mkdirSync(join(persistentPath, "data"), { recursive: true });
  } catch (err) {
    runtime?.error?.(`signal-cli: failed to create persistent directory: ${String(err)}`);
    return;
  }

  // Create parent directory for symlink
  try {
    const parentDir = join(homedir(), ".local", "share");
    mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    runtime?.error?.(`signal-cli: failed to create parent directory: ${String(err)}`);
    return;
  }

  // Create symlink
  try {
    symlinkSync(persistentPath, defaultPath);
    log(`signal-cli: linked ${defaultPath} -> ${persistentPath} for persistence`);
  } catch (err) {
    runtime?.error?.(`signal-cli: failed to create symlink: ${String(err)}`);
  }
}

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // signal-cli commonly writes all logs to stderr; treat severity explicitly.
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) return "error";
  // Some signal-cli failures are not tagged with WARN/ERROR but should still be surfaced loudly.
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) return "error";
  return "log";
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) args.push("--ignore-attachments");
  if (opts.ignoreStories) args.push("--ignore-stories");
  if (opts.sendReadReceipts) args.push("--send-read-receipts");

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  // Setup persistent storage for containerized environments
  setupSignalDataPersistence(opts.runtime);

  const args = buildDaemonArgs(opts);
  const child = spawn(opts.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});

  child.stdout?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") log(`signal-cli: ${line.trim()}`);
      else if (kind === "error") error(`signal-cli: ${line.trim()}`);
    }
  });
  child.stderr?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") log(`signal-cli: ${line.trim()}`);
      else if (kind === "error") error(`signal-cli: ${line.trim()}`);
    }
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
  });

  return {
    pid: child.pid ?? undefined,
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}
