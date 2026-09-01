/** Classifies service PATH entries that should not be frozen into daemons. */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Service PATH policy keeps managed services away from user shell package-manager paths.
function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizeServicePathEntry(entry: string, platform: NodeJS.Platform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(entry).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalizeLowercaseStringOrEmpty(normalized);
  }
  return normalized;
}

export function isNonMinimalServicePathEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return false;
  }
  const normalized = normalizeServicePathEntry(entry, platform);
  // User shell package-manager paths are fragile in non-interactive services and
  // should be replaced by stable system/runtime paths.
  return (
    normalized.includes("/.nvm/") ||
    normalized.includes("/.fnm/") ||
    normalized.includes("/.local/share/fnm/") ||
    normalized.includes("/.volta/") ||
    normalized.includes("/.asdf/") ||
    normalized.includes("/.n/") ||
    normalized.includes("/.nodenv/") ||
    normalized.includes("/.nodebrew/") ||
    normalized.includes("/nvs/") ||
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/pnpm/") ||
    normalized.endsWith("/pnpm")
  );
}
