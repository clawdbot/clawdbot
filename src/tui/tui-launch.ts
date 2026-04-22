import { spawn } from "node:child_process";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import { TUI_SETUP_AUTH_SOURCE_CONFIG, TUI_SETUP_AUTH_SOURCE_ENV } from "./setup-launch-env.js";
import type { TuiOptions } from "./tui.js";

type TuiLaunchOptions = {
  authSource?: "config";
  gatewayUrl?: string;
};

function appendOption(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) {
    return;
  }
  args.push(flag, String(value));
}

function filterTuiExecArgv(execArgv: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index] ?? "";
    if (
      arg === "--inspect" ||
      arg.startsWith("--inspect=") ||
      arg === "--inspect-brk" ||
      arg.startsWith("--inspect-brk=") ||
      arg === "--inspect-wait" ||
      arg.startsWith("--inspect-wait=")
    ) {
      const next = execArgv[index + 1];
      if (!arg.includes("=") && typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg === "--inspect-port") {
      const next = execArgv[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--inspect-port=")) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function buildCurrentCliEntryArgs(): string[] {
  const entry = process.argv[1]?.trim();
  if (!entry) {
    throw new Error("unable to relaunch TUI: current CLI entry path is unavailable");
  }
  return path.isAbsolute(entry) ? [entry] : [];
}

function buildTuiCliArgs(opts: TuiOptions): string[] {
  const args = [...filterTuiExecArgv(process.execArgv), ...buildCurrentCliEntryArgs(), "tui"];
  if (opts.local) {
    args.push("--local");
  }
  appendOption(args, "--url", opts.url);
  appendOption(args, "--token", opts.token);
  appendOption(args, "--password", opts.password);
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

export async function launchTuiCli(
  opts: TuiOptions,
  launchOptions: TuiLaunchOptions = {},
): Promise<void> {
  const args = buildTuiCliArgs(opts);
  const env =
    launchOptions.gatewayUrl || launchOptions.authSource
      ? {
          ...process.env,
          ...(launchOptions.gatewayUrl ? { OPENCLAW_GATEWAY_URL: launchOptions.gatewayUrl } : {}),
          ...(launchOptions.authSource === "config"
            ? { [TUI_SETUP_AUTH_SOURCE_ENV]: TUI_SETUP_AUTH_SOURCE_CONFIG }
            : {}),
        }
      : process.env;
  const stdinWasPaused =
    typeof process.stdin.isPaused === "function" ? process.stdin.isPaused() : false;

  process.stdin.pause();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env,
    });
    const { detach } = attachChildProcessBridge(child);

    child.once("error", (error) => {
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
  }).finally(() => {
    if (!stdinWasPaused) {
      process.stdin.resume();
    }
  });
}
