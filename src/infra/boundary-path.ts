// Exposes boundary path resolution helpers with fs-safe defaults.
import "./fs-safe-defaults.js";
import fs from "node:fs";
import path from "node:path";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
export { safeRealpathSync } from "@openclaw/fs-safe/path";

/** Returns a canonical path when resolvable, otherwise an absolute lexical path. */
export function resolveRealpathOrAbsolute(value: string): string {
  return safeRealpathSync(value) ?? path.resolve(value);
}

export function resolveIdentityPathViaExistingAncestorSync(targetPath: string): string {
  const fallback = path.resolve(targetPath);
  const missingSegments: string[] = [];
  let cursor = fallback;

  while (true) {
    try {
      // Identity aliases must converge even after an intermediate realpath failure,
      // or ownership and lock callers can split one resource into separate identities.
      return path.join(fs.realpathSync.native(cursor), ...missingSegments.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return fallback;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
export {
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
} from "@openclaw/fs-safe/advanced";
