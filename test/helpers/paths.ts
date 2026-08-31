// Test path helpers resolve repository-relative fixture paths.
import path from "node:path";

// Cross-platform path containment helper for tests.

/** Return true when target is equal to or inside base, with Windows case folding. */
export function isPathWithinBase(base: string, target: string): boolean {
  if (process.platform === "win32") {
    const normalizedBase = path.win32.normalize(path.win32.resolve(base));
    const normalizedTarget = path.win32.normalize(path.win32.resolve(target));

    const rel = path.win32.relative(normalizedBase.toLowerCase(), normalizedTarget.toLowerCase());
    return rel === "" || (!rel.startsWith("..") && !path.win32.isAbsolute(rel));
  }

  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  const rel = path.relative(normalizedBase, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
