import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const IGNORED_INSTALLED_PLUGIN_DIR_NAMES = new Set(["node_modules", ".openclaw-install-backups"]);

export function shouldIgnoreInstalledPluginDirName(name: string): boolean {
  const normalized = normalizeOptionalLowercaseString(name);
  if (!normalized) {
    return true;
  }
  if (IGNORED_INSTALLED_PLUGIN_DIR_NAMES.has(normalized)) {
    return true;
  }
  if (normalized.startsWith(".")) {
    return true;
  }
  if (normalized.endsWith(".bak")) {
    return true;
  }
  if (normalized.includes(".backup-")) {
    return true;
  }
  if (normalized.includes(".disabled")) {
    return true;
  }
  return false;
}
