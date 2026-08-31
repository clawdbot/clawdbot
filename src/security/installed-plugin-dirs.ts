// Resolves installed plugin directories for security trust audits.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const IGNORED_INSTALLED_PLUGIN_DIR_NAMES = new Set(["node_modules", ".openclaw-install-backups"]);

/**
 * Decide whether an installed-plugin directory should be skipped by security audits.
 * This filters generated install debris while keeping real plugin roots visible to scans.
 */
function shouldIgnoreInstalledPluginDirName(name: string): boolean {
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

/**
 * Lists installed plugin directories under the state extensions dir. Read
 * failures surface through `onReadError` so audits can report scan problems,
 * except a missing extensions dir, which is the normal no-plugins state.
 */
export async function listInstalledPluginDirs(params: {
  stateDir: string;
  onReadError?: (error: unknown) => void;
}): Promise<{ extensionsDir: string; pluginDirs: string[] }> {
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await fs.stat(extensionsDir).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      params.onReadError?.(err);
    }
    return null;
  });
  if (!st?.isDirectory()) {
    return { extensionsDir, pluginDirs: [] };
  }
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err: unknown) => {
    params.onReadError?.(err);
    return [];
  });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !shouldIgnoreInstalledPluginDirName(name))
    .filter(Boolean);
  return { extensionsDir, pluginDirs };
}
