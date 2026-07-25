#!/usr/bin/env node

import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function decodePayload(argv) {
  const payloadFileIndex = argv.indexOf("--payload-file");
  if (payloadFileIndex < 0) {
    throw new Error("Missing --payload-file");
  }
  const payloadFile = argv[payloadFileIndex + 1];
  if (!payloadFile) {
    throw new Error("Missing --payload-file value");
  }
  const payloadJson = readFileSync(payloadFile, "utf8");
  rmSync(path.dirname(payloadFile), { force: true, recursive: true });
  return JSON.parse(payloadJson);
}

const FORWARDED_SIGNAL_EXIT_GRACE_MS = 1000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

function formatErrorStack(error) {
  if (error && typeof error === "object" && typeof error.stack === "string") {
    return error.stack;
  }
  return String(error);
}

export function forwardSignals(spawned, options = {}) {
  let exitTimer;
  const exitGraceMs = options.exitGraceMs ?? FORWARDED_SIGNAL_EXIT_GRACE_MS;
  const scheduleExit = (signal) => {
    if (exitTimer) {
      return;
    }
    const setTimeoutFn = options.setTimeout ?? setTimeout;
    exitTimer = setTimeoutFn(() => {
      const exit = options.exit ?? process.exit;
      exit(signalExitCode(signal));
    }, exitGraceMs);
    exitTimer?.unref?.();
  };

  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      try {
        spawned.kill(signal);
      } catch {
        // Ignore kill errors while the sandbox process is already exiting.
      }
      scheduleExit(signal);
    });
  }
}

function bridgeStdio(pty) {
  pty.onData((data) => {
    process.stdout.write(data);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => {
    pty.write(data);
  });
  process.stdin.on("end", () => {
    pty.write("\x04");
  });
}

function bridgeChildProcess(child) {
  child.stdout?.on("data", (data) => {
    process.stdout.write(data);
  });
  child.stderr?.on("data", (data) => {
    process.stderr.write(data);
  });
  process.stdin.on("data", (data) => {
    child.stdin?.write(data);
  });
  process.stdin.on("end", () => {
    child.stdin?.end();
  });
}

export function exitOnChildProcessClose(child, options = {}) {
  child.on("close", (exitCode, signal) => {
    const exit = options.exit ?? process.exit;
    exit(typeof exitCode === "number" ? exitCode : signalExitCode(signal));
  });
}

const SIGNAL_NUMBERS = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGQUIT", 3],
  ["SIGTERM", 15],
]);

export function signalExitCode(signal) {
  if (typeof signal === "number" && Number.isFinite(signal)) {
    return 128 + signal;
  }
  if (typeof signal === "string") {
    const signalNumber = SIGNAL_NUMBERS.get(signal);
    if (signalNumber !== undefined) {
      return 128 + signalNumber;
    }
  }
  return 1;
}

function isMain() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

export async function main() {
  try {
    const { config, options } = decodePayload(process.argv.slice(2));
    const { spawnSandboxFromConfig } = await import("@microsoft/mxc-sdk");
    const spawned = await spawnSandboxFromConfig(config, options ?? {});

    if (typeof spawned.onData === "function") {
      bridgeStdio(spawned);
      forwardSignals(spawned);
      spawned.onExit(({ exitCode, signal }) => {
        process.exit(typeof exitCode === "number" ? exitCode : signalExitCode(signal));
      });
      return;
    }

    bridgeChildProcess(spawned);
    forwardSignals(spawned);
    exitOnChildProcessClose(spawned);
  } catch (error) {
    process.stderr.write(`${formatErrorStack(error)}\n`);
    process.exit(127);
  }
}

if (isMain()) {
  void main();
}
