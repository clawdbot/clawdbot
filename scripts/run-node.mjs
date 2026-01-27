#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const compiler = env.CLAWDBOT_TS_COMPILER === "tsc" ? "tsc" : "tsgo";
const projectArgs = ["--project", "tsconfig.json"];

const distRoot = path.join(cwd, "dist");
const distEntry = path.join(distRoot, "entry.js");
const buildStampPath = path.join(distRoot, ".buildstamp");
const srcRoot = path.join(cwd, "src");
const configFiles = [path.join(cwd, "tsconfig.json"), path.join(cwd, "package.json")];

const statMtime = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) return false;
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkip?.(fullPath)) continue;
      const mtime = statMtime(fullPath);
      if (mtime == null) continue;
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const shouldBuild = () => {
  if (env.CLAWDBOT_FORCE_BUILD === "1") return true;
  const stampMtime = statMtime(buildStampPath);
  if (stampMtime == null) return true;
  if (statMtime(distEntry) == null) return true;

  for (const filePath of configFiles) {
    const mtime = statMtime(filePath);
    if (mtime != null && mtime > stampMtime) return true;
  }

  const srcMtime = findLatestMtime(srcRoot, isExcludedSource);
  if (srcMtime != null && srcMtime > stampMtime) return true;
  return false;
};

const logRunner = (message) => {
  if (env.CLAWDBOT_RUNNER_LOG === "0") return;
  process.stderr.write(`[moltbot] ${message}\n`);
};

const runNode = () => {
  const nodeProcess = spawn(process.execPath, ["dist/entry.js", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (exitCode, exitSignal) => {
    if (exitSignal) {
      process.exit(1);
      return;
    }
    process.exit(exitCode ?? 1);
  });
};

const writeBuildStamp = () => {
  try {
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(buildStampPath, `${Date.now()}\n`);
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`);
  }
};

if (!shouldBuild()) {
  runNode();
} else {
  logRunner("Building TypeScript (dist is stale).");
  const pnpmArgs = ["exec", compiler, ...projectArgs];
  const buildCmd = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const buildArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...pnpmArgs] : pnpmArgs;
  const build = spawn(buildCmd, buildArgs, {
    cwd,
    env,
    stdio: "inherit",
  });

  build.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }
    if (code !== 0 && code !== null) {
      process.exit(code);
      return;
    }
    writeBuildStamp();
    runNode();
  });
}
