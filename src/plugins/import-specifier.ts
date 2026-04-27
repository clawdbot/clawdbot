import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * On Windows, Node's ESM loader requires absolute paths to be expressed as
 * file:// URLs. Raw drive-letter paths like C:\... are parsed as URL schemes.
 */
export function toSafeImportPath(specifier: string): string {
  if (process.platform !== "win32") {
    return specifier;
  }
  if (specifier.startsWith("file://")) {
    return specifier;
  }
  if (path.win32.isAbsolute(specifier)) {
    return pathToFileURL(specifier, { windows: true }).href;
  }
  return specifier;
}
