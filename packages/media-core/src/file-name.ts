// Media Core module implements file name behavior.
import path from "node:path";

/**
 * Returns the final filename segment for either POSIX or Windows-style paths.
 *
 * A bare "." or ".." is a path-navigation segment rather than a filename, so it
 * collapses to "". Callers treat "" as "no filename" and fall back, and this
 * keeps a literal ".." from reaching code that joins the result into a path or
 * uses it as a stored filename.
 */
export function basenameFromAnyPath(value: string): string {
  const base = path.win32.basename(path.posix.basename(value));
  return base === "." || base === ".." ? "" : base;
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
