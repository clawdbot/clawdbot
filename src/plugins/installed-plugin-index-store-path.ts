// Resolves filesystem paths for installed plugin index storage.
import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";

const LEGACY_INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");

/** Options for resolving installed plugin index storage paths. */
export type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
  artifactPreservingReadOnly?: boolean;
};

function resolveStoreEnv(options: InstalledPluginIndexStoreOptions): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  if (options.stateDir) {
    return { ...env, OPENCLAW_STATE_DIR: options.stateDir };
  }
  if (hasActivePluginInstallRoots()) {
    return { ...env, OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(env).stateDir };
  }
  return env;
}

/** Resolves the canonical SQLite-backed installed plugin index path. */
export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  return resolveOpenClawStateSqlitePath(resolveStoreEnv(options));
}

/** Resolves state database options for the installed plugin index store. */
export function resolveInstalledPluginIndexStateDatabaseOptions(
  options: InstalledPluginIndexStoreOptions = {},
): OpenClawStateDatabaseOptions {
  if (options.filePath) {
    return {
      ...(options.env ? { env: options.env } : {}),
      path: options.filePath,
    };
  }
  return { env: resolveStoreEnv(options) };
}

/** Resolves the legacy JSON installed plugin index path for migration/doctor use. */
export function resolveLegacyInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveActivePluginInstallRoots(env).stateDir;
  return path.join(stateDir, LEGACY_INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
