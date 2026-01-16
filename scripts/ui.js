#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write(
    "Usage: node scripts/ui.js <install|dev|build|test> [...args]\n",
  );
}

function which(cmd) {
  try {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const paths = (process.env[key] ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
        : [""];
    for (const entry of paths) {
      for (const ext of extensions) {
        const candidate = path.join(entry, process.platform === "win32" ? `${cmd}${ext}` : cmd);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveRunner() {
  // CLAWDBOT_PREFER_PNPM=1 forces pnpm (useful in Docker on architectures where Bun fails)
  const preferPnpm = process.env.CLAWDBOT_PREFER_PNPM === "1";
  if (!preferPnpm) {
    const bun = which("bun");
    if (bun) return { cmd: bun, kind: "bun" };
  }
  const pnpm = which("pnpm");
  if (pnpm) return { cmd: pnpm, kind: "pnpm" };
  if (preferPnpm) {
    // Fallback to bun if pnpm not found even when preferring pnpm
    const bun = which("bun");
    if (bun) return { cmd: bun, kind: "bun" };
  }
  return null;
}

function run(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: uiDir,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

function runSync(cmd, args, envOverride) {
  const result = spawnSync(cmd, args, {
    cwd: uiDir,
    stdio: "inherit",
    env: envOverride ?? process.env,
  });
  if (result.signal) process.exit(1);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function depsInstalled(kind) {
  try {
    const require = createRequire(path.join(uiDir, "package.json"));
    require.resolve("vite");
    require.resolve("dompurify");
    if (kind === "test") {
      require.resolve("vitest");
      require.resolve("@vitest/browser-playwright");
      require.resolve("playwright");
    }
    return true;
  } catch {
    return false;
  }
}

const [, , action, ...rest] = process.argv;
if (!action) {
  usage();
  process.exit(2);
}

const runner = resolveRunner();
if (!runner) {
  process.stderr.write(
    "Missing UI runner: install bun or pnpm, then retry.\n",
  );
  process.exit(1);
}

const script =
  action === "install"
    ? null
    : action === "dev"
      ? "dev"
      : action === "build"
        ? "build"
        : action === "test"
          ? "test"
          : null;

if (action !== "install" && !script) {
  usage();
  process.exit(2);
}

if (runner.kind === "bun") {
  if (action === "install") run(runner.cmd, ["install", ...rest]);
  else {
    if (!depsInstalled(action === "test" ? "test" : "build")) {
      const installEnv =
        action === "build"
          ? { ...process.env, NODE_ENV: "production" }
          : process.env;
      const installArgs =
        action === "build" ? ["install", "--production"] : ["install"];
      runSync(runner.cmd, installArgs, installEnv);
    }
    run(runner.cmd, ["run", script, ...rest]);
  }
} else {
  if (action === "install") run(runner.cmd, ["install", ...rest]);
  else {
    if (!depsInstalled(action === "test" ? "test" : "build")) {
      const installEnv =
        action === "build"
          ? { ...process.env, NODE_ENV: "production" }
          : process.env;
      const installArgs =
        action === "build" ? ["install", "--prod"] : ["install"];
      runSync(runner.cmd, installArgs, installEnv);
    }
    run(runner.cmd, ["run", script, ...rest]);
  }
}
