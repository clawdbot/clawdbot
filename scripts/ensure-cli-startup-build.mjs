#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryCandidates = ["dist/entry.js", "dist/entry.mjs"];

export function hasCliStartupBuild(params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const exists = params.existsSync ?? existsSync;
  return entryCandidates.some((relativePath) => exists(path.join(rootDir, relativePath)));
}

export function ensureCliStartupBuild(params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  if (hasCliStartupBuild({ rootDir, existsSync: params.existsSync })) {
    return { built: false };
  }

  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const spawn = params.spawnSync ?? spawnSync;
  const buildScript = path.join(rootDir, "scripts", "build-all.mjs");

  console.error("[cli-startup-build] dist/entry missing; running cliStartup build profile");
  const result = spawn(nodeExecPath, [buildScript, "cliStartup"], {
    cwd: rootDir,
    env: params.env ?? process.env,
    stdio: params.stdio ?? "inherit",
  });
  const status = result.status ?? (result.signal ? 1 : 0);
  if (status !== 0) {
    throw new Error(`cliStartup build profile failed with exit code ${status}`);
  }
  return { built: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureCliStartupBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
