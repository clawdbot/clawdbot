import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const LEGACY_INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");

export type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

function resolveStoreEnv(options: InstalledPluginIndexStoreOptions): NodeJS.ProcessEnv {
  return options.stateDir
    ? { ...(options.env ?? process.env), OPENCLAW_STATE_DIR: options.stateDir }
    : (options.env ?? process.env);
}

export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  return resolveOpenClawStateSqlitePath(resolveStoreEnv(options));
}

export function resolveLegacyInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  return path.join(stateDir, LEGACY_INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
