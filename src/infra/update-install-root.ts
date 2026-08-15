import fs from "node:fs";
import path from "node:path";

/** Resolve the canonical identity of an update checkout/install root. */
export function resolveUpdateInstallRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

export function updateInstallRootsMatch(left: string, right: string): boolean {
  return resolveUpdateInstallRoot(left) === resolveUpdateInstallRoot(right);
}
