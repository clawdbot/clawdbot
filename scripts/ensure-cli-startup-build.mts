#!/usr/bin/env node

// Ensures CLI startup benchmark assets are built before checks.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const entryCandidates = ["dist/entry.js", "dist/entry.mjs"];
const startupMetadataPath = "dist/cli-startup-metadata.json";
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

type StartupBuildParams = Partial<{
  env: NodeJS.ProcessEnv;
  existsSync: typeof existsSync;
  killSignal: NodeJS.Signals;
  nodeExecPath: string;
  rootDir: string;
  spawnSync: (...args: Parameters<typeof spawnSync>) => Partial<ReturnType<typeof spawnSync>>;
  stdio: "inherit" | "pipe";
  timeoutMs: number;
}>;

/**
 * Resolves the CLI startup build timeout from environment.
 */
export function resolveCliStartupBuildTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return readPositiveEnvInt("OPENCLAW_CLI_STARTUP_BUILD_TIMEOUT_MS", env, DEFAULT_BUILD_TIMEOUT_MS);
}

/**
 * Reports whether required CLI startup build outputs exist.
 */
export function hasCliStartupBuild(params: StartupBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const exists = params.existsSync ?? existsSync;
  const hasEntry = entryCandidates.some((relativePath) => exists(path.join(rootDir, relativePath)));
  return hasEntry && exists(path.join(rootDir, startupMetadataPath));
}

/**
 * Builds CLI startup assets when required outputs are missing.
 */
export function ensureCliStartupBuild(params: StartupBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  if (hasCliStartupBuild({ rootDir, existsSync: params.existsSync })) {
    return { built: false };
  }

  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const spawn = params.spawnSync ?? spawnSync;
  const buildScript = path.join(rootDir, "scripts", "build-all.mts");

  console.error(
    "[cli-startup-build] dist startup entry or metadata missing; running cliStartup build profile",
  );
  const result = spawn(nodeExecPath, ["--import", "tsx", buildScript, "cliStartup"], {
    cwd: rootDir,
    env: params.env ?? process.env,
    killSignal: params.killSignal ?? "SIGKILL",
    stdio: params.stdio ?? "inherit",
    timeout: params.timeoutMs ?? resolveCliStartupBuildTimeoutMs(params.env ?? process.env),
  });
  if (result.error) {
    throw result.error;
  }
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
