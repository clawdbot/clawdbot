// Media Core module implements file name behavior.
import path from "node:path";

/** Returns the final filename segment for either POSIX or Windows-style paths. */
export function basenameFromAnyPath(value: string): string {
  return path.win32.basename(path.posix.basename(value));
}

/** Returns the extension from the final filename segment of any path flavor. */
export function extnameFromAnyPath(value: string): string {
  return path.extname(basenameFromAnyPath(value));
}

/** Returns the extensionless filename from the final segment of any path flavor. */
export function nameFromAnyPath(value: string): string {
  const base = basenameFromAnyPath(value);
  const ext = path.extname(base);
  return path.basename(base, ext);
}
