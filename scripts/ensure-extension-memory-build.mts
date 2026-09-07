#!/usr/bin/env node

// Ensures memory extension runtime entries are built before checks.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginRootPublicSurfacePath } from "../src/plugins/public-surface-runtime.js";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./lib/bundled-plugin-build-entries.mjs";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

type ExtensionMemoryBuildParams = {
  env?: NodeJS.ProcessEnv;
  killSignal?: NodeJS.Signals;
  nodeExecPath?: string;
  requiredExtensionIds?: string[];
  rootDir?: string;
  spawnSync?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => { error?: Error; signal?: NodeJS.Signals | null; status: number | null };
  stdio?: "inherit" | "pipe";
  timeoutMs?: number;
};

/**
 * Resolves the extension memory build timeout from environment.
 */
export function resolveExtensionMemoryBuildTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return readPositiveEnvInt(
    "OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS",
    env,
    DEFAULT_BUILD_TIMEOUT_MS,
  );
}

function collectExpectedExtensionMemoryEntryIds(rootDir: string, env: NodeJS.ProcessEnv) {
  try {
    const entries = collectBundledPluginBuildEntries({ cwd: rootDir, env });
    return entries
      .filter(
        (entry) =>
          entry.hasManifest &&
          !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(entry.id) &&
          entry.sourceEntries.length > 0,
      )
      .map((entry) => entry.id)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return null;
  }
}

/** Discovers built index entries for readiness checks and RSS profiling. */
export function findBuiltExtensionMemoryEntries(rootDir: string = repoRoot) {
  const entries = new Map<string, string>();
  // Prefer canonical root output over package-local builds; source-only entries
  // returned by the public-surface resolver must never enter a built-RSS run.
  for (const extensionsDir of [
    path.join(rootDir, "dist", "extensions"),
    path.join(rootDir, "extensions"),
  ]) {
    let extensionIds: string[];
    try {
      extensionIds = readdirSync(extensionsDir);
    } catch {
      continue;
    }
    for (const dir of extensionIds) {
      if (entries.has(dir)) {
        continue;
      }
      const file = resolvePluginRootPublicSurfacePath({
        pluginRoot: path.join(extensionsDir, dir),
        artifactBasename: "index.js",
      });
      if (file && /\.[cm]?js$/u.test(file)) {
        entries.set(dir, file);
      }
    }
  }
  return [...entries]
    .map(([dir, file]) => ({ dir, file }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));
}

/** Reports whether all required built memory extension entries exist. */
export function hasBuiltExtensionMemoryEntries(params: ExtensionMemoryBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const builtIds = new Set(findBuiltExtensionMemoryEntries(rootDir).map((entry) => entry.dir));
  const requiredExtensionIds =
    (params.requiredExtensionIds?.length ?? 0) > 0
      ? params.requiredExtensionIds
      : collectExpectedExtensionMemoryEntryIds(rootDir, params.env ?? process.env);
  if (!requiredExtensionIds || requiredExtensionIds.length === 0) {
    return builtIds.size > 0;
  }
  return requiredExtensionIds.every((id) => builtIds.has(id));
}

/**
 * Builds memory extension entries when required outputs are missing.
 */
export function ensureExtensionMemoryBuild(params: ExtensionMemoryBuildParams = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  if (hasBuiltExtensionMemoryEntries(params)) {
    return { built: false };
  }

  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const spawn = params.spawnSync ?? spawnSync;
  const buildScript = path.join(rootDir, "scripts", "build-all.mts");

  console.error(
    "[extension-memory-build] required built plugin entries missing; running cliStartup build profile",
  );
  const result = spawn(nodeExecPath, ["--import", "tsx", buildScript, "cliStartup"], {
    cwd: rootDir,
    env: params.env ?? process.env,
    killSignal: params.killSignal ?? "SIGKILL",
    stdio: params.stdio ?? "inherit",
    timeout: params.timeoutMs ?? resolveExtensionMemoryBuildTimeoutMs(params.env ?? process.env),
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
    ensureExtensionMemoryBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
