// Resolves installed plugin directories for security trust audits.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const IGNORED_INSTALLED_PLUGIN_DIR_NAMES = new Set(["node_modules", ".openclaw-install-backups"]);

/**
 * Decide whether an installed-plugin directory should be skipped by security audits.
 * This filters generated install debris while keeping real plugin roots visible to scans.
 */
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
  // Failed installs and rollback copies can contain stale plugin code; audit the live
  // root once and ignore these generated backups so findings stay actionable.
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
