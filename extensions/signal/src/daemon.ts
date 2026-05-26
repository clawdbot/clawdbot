import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

type SignalDaemonOpts = {
  cliPath: string;
  configPath?: string;
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
  exited: Promise<SignalDaemonExitEvent>;
  isExited: () => boolean;
};

export type SignalDaemonExitEvent = {
  source: "process" | "spawn-error";
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function formatSignalDaemonExit(exit: SignalDaemonExitEvent): string {
  return `signal daemon exited (source=${exit.source} code=${exit.code ?? "null"} signal=${exit.signal ?? "null"})`;
}

function isRecoverableSignalCliReceiveException(line: string): boolean {
  return /\breceive exception:\s+.*\binvalid PreKey message:\s+decryption failed\b/i.test(line);
}

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  // signal-cli commonly writes routine logs and warnings to stderr; only error-like lines should
  // update channel failure state. Recoverable receive decrypt failures are noisy but non-fatal.
  if (/\bERROR\b/.test(trimmed)) {
    return "error";
  }
  if (isRecoverableSignalCliReceiveException(trimmed)) {
    return "log";
  }
  // Some signal-cli failures are not tagged with ERROR but should still be surfaced loudly.
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return "error";
  }
  return "log";
}

function bindSignalCliOutput(params: {
  stream: NodeJS.ReadableStream | null | undefined;
  log: (message: string) => void;
  error: (message: string) => void;
}): void {
  params.stream?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        params.log(`signal-cli: ${line.trim()}`);
      } else if (kind === "error") {
        params.error(`signal-cli: ${line.trim()}`);
      }
    }
  });
}

function resolveSignalCliConfigPath(raw: string): string {
  const value = raw.trim();
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.configPath?.trim()) {
    args.push("--config", resolveSignalCliConfigPath(opts.configPath));
  }
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) {
    args.push("--ignore-attachments");
  }
  if (opts.ignoreStories) {
    args.push("--ignore-stories");
  }
  if (opts.sendReadReceipts) {
    args.push("--send-read-receipts");
  }

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  const args = buildDaemonArgs(opts);
  const child = spawn(opts.cliPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});
  let exited = false;
  let settledExit = false;
  let resolveExit!: (value: SignalDaemonExitEvent) => void;
  const exitedPromise = new Promise<SignalDaemonExitEvent>((resolve) => {
    resolveExit = resolve;
  });
  const settleExit = (value: SignalDaemonExitEvent) => {
    if (settledExit) {
      return;
    }
    settledExit = true;
    exited = true;
    resolveExit(value);
  };

  bindSignalCliOutput({ stream: child.stdout, log, error });
  bindSignalCliOutput({ stream: child.stderr, log, error });
  child.once("exit", (code, signal) => {
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
    error(
      formatSignalDaemonExit({ source: "process", code: code ?? null, signal: signal ?? null }),
    );
  });
  child.once("close", (code, signal) => {
    settleExit({
      source: "process",
      code: typeof code === "number" ? code : null,
      signal: signal ?? null,
    });
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
    settleExit({ source: "spawn-error", code: null, signal: null });
  });

  return {
    pid: child.pid ?? undefined,
    exited: exitedPromise,
    isExited: () => exited,
    stop: () => {
      if (!child.killed && !exited) {
        child.kill("SIGTERM");
      }
    },
  };
}

export const testApi = {
  buildDaemonArgs,
  classifySignalCliLogLine,
  resolveSignalCliConfigPath,
} as const;
