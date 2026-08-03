#!/usr/bin/env node

// Ensures memory extension runtime entries are built before checks.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectBundledPluginBuildEntries,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./lib/bundled-plugin-build-entries.mjs";
import { readPositiveEnvInt } from "./lib/numeric-options.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the extension memory build timeout from environment.
 */
export function resolveExtensionMemoryBuildTimeoutMs(env = process.env) {
  return readPositiveEnvInt(
    "OPENCLAW_EXTENSION_MEMORY_BUILD_TIMEOUT_MS",
    env,
    DEFAULT_BUILD_TIMEOUT_MS,
  );
}

function collectExpectedExtensionMemoryEntryIds(rootDir, env) {
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

/**
 * Reports whether built memory extension entries exist.
 */
export function hasBuiltExtensionMemoryEntries(params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const exists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const extensionsDir = path.join(rootDir, "dist", "extensions");
  if (!exists(extensionsDir)) {
    return false;
  }
  let extensionIds;
  try {
    extensionIds = readDir(extensionsDir);
  } catch {
    return false;
  }
  const requiredExtensionIds =
    params.requiredExtensionIds?.length > 0
      ? params.requiredExtensionIds
      : collectExpectedExtensionMemoryEntryIds(rootDir, params.env ?? process.env);
  if (!requiredExtensionIds || requiredExtensionIds.length === 0) {
    return extensionIds.some((extensionId) =>
      exists(path.join(extensionsDir, extensionId, "index.js")),
    );
  }
  return requiredExtensionIds.every((extensionId) =>
    exists(path.join(extensionsDir, extensionId, "index.js")),
  );
}

/**
 * Builds memory extension entries when required outputs are missing.
 */
export function ensureExtensionMemoryBuild(params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  if (
    hasBuiltExtensionMemoryEntries({
      rootDir,
      existsSync: params.existsSync,
      readdirSync: params.readdirSync,
      requiredExtensionIds: params.requiredExtensionIds,
      env: params.env,
    })
  ) {
    return { built: false };
  }

  const nodeExecPath = params.nodeExecPath ?? process.execPath;
  const spawn = params.spawnSync ?? spawnSync;
  const buildScript = path.join(rootDir, "scripts", "build-all.mjs");

  console.error(
    "[extension-memory-build] dist/extensions missing; running cliStartup build profile",
  );
  const result = spawn(nodeExecPath, [buildScript, "cliStartup"], {
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
