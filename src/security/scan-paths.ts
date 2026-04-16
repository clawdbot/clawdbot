import fs from "node:fs";
import path from "node:path";

export function isPathInside(basePath: string, candidatePath: string): boolean {
  const base = path.resolve(basePath);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

export function isPathInsideWithRealpath(
  basePath: string,
  candidatePath: string,
  opts?: { requireRealpath?: boolean },
): boolean {
  if (!isPathInside(basePath, candidatePath)) {
    return false;
  }
  const baseReal = safeRealpathSync(basePath);
  const candidateReal = safeRealpathSync(candidatePath);
  if (!baseReal || !candidateReal) {
    // Default to false (safe): only bypass the realpath check when the caller
    // explicitly opts out with requireRealpath: false. All production callers
    // already pass requireRealpath: true; this change makes the default secure.
    return opts?.requireRealpath === false;
  }
  return isPathInside(baseReal, candidateReal);
}

export function extensionUsesSkippedScannerPath(entry: string): boolean {
  const segments = entry.split(/[\\/]+/).filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "node_modules" ||
      (segment.startsWith(".") && segment !== "." && segment !== ".."),
  );
}
