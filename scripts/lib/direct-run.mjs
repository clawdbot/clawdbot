import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function isDirectRunUrl(directPath, moduleUrl, platform = process.platform) {
  return isDirectRunPath(directPath, fileURLToPath(moduleUrl), platform);
}
