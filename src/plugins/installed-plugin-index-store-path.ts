import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export const INSTALLED_PLUGIN_INDEX_STORE_PATH = path.join("plugins", "installs.json");

export type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

export function resolveInstalledPluginIndexStorePath(
  options: InstalledPluginIndexStoreOptions = {},
): string {
  if (options.filePath) {
    return options.filePath;
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  return path.join(stateDir, INSTALLED_PLUGIN_INDEX_STORE_PATH);
}
