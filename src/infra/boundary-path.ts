// Exposes boundary path resolution helpers with fs-safe defaults.
import "./fs-safe-defaults.js";
import path from "node:path";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
export { safeRealpathSync } from "@openclaw/fs-safe/path";

/** Returns a canonical path when resolvable, otherwise an absolute lexical path. */
export function resolveRealpathOrAbsolute(value: string): string {
  return safeRealpathSync(value) ?? path.resolve(value);
}

// Boundary path resolution keeps alias expansion and realpath checks in one
// shared contract before file IO happens.
export {
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
} from "@openclaw/fs-safe/advanced";
