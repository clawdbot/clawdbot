#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { spawn } from "@lydell/node-pty";
import { readPositiveIntEnv } from "./env-limits.mjs";

const [logPath, command, ...args] = process.argv.slice(2);
const OUTPUT_MAX_BYTES = readPositiveIntEnv("OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES", 16 * 1024 * 1024);
const FORCE_KILL_MS = readPositiveIntEnv("OPENCLAW_E2E_PTY_FORCE_KILL_MS", 5_000);

if (!logPath || !command) {
  console.error("usage: run-with-pty.mjs <log-path> <command> [args...]");
  process.exit(2);
}

const log = fs.createWriteStream(logPath, { flags: "w" });
const pty = spawn(command, args, {
  name: process.env.TERM || "xterm-256color",
  cols: readPositiveIntEnv("COLUMNS", 120),
  rows: readPositiveIntEnv("LINES", 40),
  cwd: process.cwd(),
  env: process.env,
});

let exiting = false;
let forwardedSignal = null;
let forceKillTimer = null;
const outputLimitMarker = `\n[run-with-pty output truncated after ${OUTPUT_MAX_BYTES} bytes]\n`;
const outputState = {
  bytes: 0,
  truncated: false,
};

function writeCappedOutput(data) {
  if (outputState.truncated) {
    return;
  }
  const buffer = Buffer.from(data);
  const remainingBytes = OUTPUT_MAX_BYTES - outputState.bytes;
  if (buffer.byteLength <= remainingBytes) {
    outputState.bytes += buffer.byteLength;
    log.write(buffer);
    process.stdout.write(buffer);
    return;
  }
  if (remainingBytes > 0) {
    const head = buffer.subarray(0, remainingBytes);
    log.write(head);
    process.stdout.write(head);
  }
  outputState.bytes = OUTPUT_MAX_BYTES;
  outputState.truncated = true;
  log.write(outputLimitMarker);
  process.stdout.write(outputLimitMarker);
}

pty.onData((data) => {
  writeCappedOutput(data);
});

pty.onExit(({ exitCode, signal }) => {
  exiting = true;
  clearTimeout(forceKillTimer);
  log.end(() => {
    if (forwardedSignal) {
      process.exit(signalExitCode(forwardedSignal));
    }
    if (typeof exitCode === "number") {
      process.exit(exitCode);
    }
    process.exit(signal ? 128 + signal : 1);
  });
});

process.stdin.on("data", (chunk) => {
  pty.write(chunk.toString("utf8"));
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!exiting) {
      forwardedSignal ??= signal;
      pty.kill(signal);
      forceKillTimer ??= setTimeout(() => {
        pty.kill("SIGKILL");
      }, FORCE_KILL_MS);
      forceKillTimer.unref?.();
    }
  });
}

function signalExitCode(signal) {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}
