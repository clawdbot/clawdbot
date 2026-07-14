// Compares direct-run paths and module URLs across POSIX and Windows path rules.
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Return whether a direct-run path points at the current module path.
 * @internal Directly tested script implementation detail.
 */
export function isDirectRunPath(directPath, modulePath, platform = process.platform) {
  if (!directPath || !modulePath) {
    return false;
  }
  const pathImpl = platform === "win32" ? path.win32 : path;
  const normalize =
    platform === "win32"
      ? (value) => pathImpl.resolve(value).toLowerCase()
      : (value) => pathImpl.resolve(value);
  return normalize(directPath) === normalize(modulePath);
}

/** Return whether a direct-run path points at the current module URL. */
export function isDirectRunUrl(directPath, moduleUrl, platform = process.platform) {
  return isDirectRunPath(directPath, fileURLToPath(moduleUrl), platform);
}
