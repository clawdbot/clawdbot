#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { spawn } from "@lydell/node-pty";
import { readPositiveIntEnv } from "./env-limits.mjs";

const [logPath, command, ...args] = process.argv.slice(2);

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

pty.onData((data) => {
  log.write(data);
  process.stdout.write(data);
});

pty.onExit(({ exitCode, signal }) => {
  exiting = true;
  log.end(() => {
    if (typeof exitCode === "number") {
      process.exit(exitCode);
    }
    process.exit(signal ? 128 + signal : 1);
  });
});

process.stdin.on("data", (chunk) => {
  pty.write(chunk.toString("utf8"));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!exiting) {
      pty.kill(signal);
    }
  });
}
