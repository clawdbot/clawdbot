#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { spawn as spawnPty } from "@lydell/node-pty";
import { readPositiveIntEnv } from "./env-limits.mjs";

const [logPath, command, ...args] = process.argv.slice(2);
const OUTPUT_MAX_BYTES = readPositiveIntEnv("OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES", 16 * 1024 * 1024);
const FORCE_KILL_MS = readPositiveIntEnv("OPENCLAW_E2E_PTY_FORCE_KILL_MS", 5_000);

if (!logPath || !command) {
  console.error("usage: run-with-pty.mjs <log-path> <command> [args...]");
  process.exit(2);
}

let exiting = false;
let forwardedSignal = null;
let forceKillTimer = null;
let terminationDrainTimer = null;
let terminationPids = [];
let pendingExitCode = null;
let logFailed = false;
const outputLimitMarker = `\n[run-with-pty output truncated after ${OUTPUT_MAX_BYTES} bytes]\n`;
const outputState = {
  bytes: 0,
  truncated: false,
};

const log = fs.createWriteStream(logPath, { flags: "w" });
const pty = spawnPty(command, args, {
  name: process.env.TERM || "xterm-256color",
  cols: readPositiveIntEnv("COLUMNS", 120),
  rows: readPositiveIntEnv("LINES", 40),
  cwd: process.cwd(),
  env: process.env,
});

log.on("error", (error) => {
  if (logFailed) {
    return;
  }
  logFailed = true;
  console.error(`run-with-pty transcript log failed: ${error.message}`);
  if (exiting) {
    process.exit(1);
  }
  if (!exiting) {
    terminatePtyTree("SIGTERM");
  }
});

function writeCappedOutput(data) {
  if (outputState.truncated) {
    return;
  }
  const buffer = Buffer.from(data);
  const remainingBytes = OUTPUT_MAX_BYTES - outputState.bytes;
  if (buffer.byteLength <= remainingBytes) {
    outputState.bytes += buffer.byteLength;
    if (!logFailed) {
      log.write(buffer);
    }
    process.stdout.write(buffer);
    return;
  }
  if (remainingBytes > 0) {
    const head = buffer.subarray(0, remainingBytes);
    if (!logFailed) {
      log.write(head);
    }
    process.stdout.write(head);
  }
  outputState.bytes = OUTPUT_MAX_BYTES;
  outputState.truncated = true;
  if (!logFailed) {
    log.write(outputLimitMarker);
  }
  process.stdout.write(outputLimitMarker);
}

pty.onData((data) => {
  writeCappedOutput(data);
});

pty.onExit(({ exitCode, signal }) => {
  exiting = true;
  if (terminationPids.length === 0) {
    clearTerminationTimers();
  }
  if (logFailed) {
    exitWhenTerminationDrains(1);
    return;
  }
  log.end(() => {
    if (forwardedSignal) {
      exitWhenTerminationDrains(signalExitCode(forwardedSignal));
      return;
    }
    if (typeof exitCode === "number") {
      exitWhenTerminationDrains(exitCode);
      return;
    }
    exitWhenTerminationDrains(signal ? 128 + signal : 1);
  });
});

process.stdin.on("data", (chunk) => {
  pty.write(chunk.toString("utf8"));
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!exiting) {
      forwardedSignal ??= signal;
      terminatePtyTree(signal);
    }
  });
}

function terminatePtyTree(signal) {
  // node-pty kill() targets only pty.pid on Unix; wrapper-owned shutdowns
  // keep the captured child tree alive until ignored descendants drain.
  if (terminationPids.length === 0) {
    terminationPids = collectPtyProcessTreePids();
  }
  signalPtyProcessTree(signal);
  forceKillTimer ??= setTimeout(() => {
    signalPtyProcessTree("SIGKILL");
  }, FORCE_KILL_MS);
  forceKillTimer.unref?.();
}

function exitWhenTerminationDrains(exitCode) {
  pendingExitCode = exitCode;
  if (processTreeIsAlive(terminationPids)) {
    terminationDrainTimer ??= setInterval(finishIfTerminationDrained, 25);
    return;
  }
  finishIfTerminationDrained();
}

function finishIfTerminationDrained() {
  if (processTreeIsAlive(terminationPids)) {
    return;
  }
  clearTerminationTimers();
  process.exit(pendingExitCode ?? 1);
}

function clearTerminationTimers() {
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
  if (terminationDrainTimer) {
    clearInterval(terminationDrainTimer);
    terminationDrainTimer = null;
  }
}

function collectPtyProcessTreePids() {
  if (process.platform === "win32" || typeof pty.pid !== "number") {
    return typeof pty.pid === "number" ? [pty.pid] : [];
  }
  const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0) {
    return [pty.pid];
  }
  const childrenByParent = new Map();
  for (const line of ps.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = childrenByParent.get(ppid) ?? [];
    siblings.push(pid);
    childrenByParent.set(ppid, siblings);
  }
  const pids = [pty.pid];
  for (const parentPid of pids) {
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function processTreeIsAlive(pids) {
  return pids.some((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  });
}

function signalPtyProcessTree(signal) {
  if (process.platform === "win32" || terminationPids.length === 0) {
    pty.kill(signal);
    return;
  }
  for (const pid of terminationPids.toReversed()) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
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
