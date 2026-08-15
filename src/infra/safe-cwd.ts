import path from "node:path";

// A removed launch directory makes Node's process.cwd() throw before callers can recover.
// Keep the absence explicit so each trust boundary chooses whether to skip, fail, or fall back.
export function tryProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

export function formatCwdRelativePathOrAbsolute(
  targetPath: string,
  samePathFallback: string,
): string {
  const cwd = tryProcessCwd();
  return cwd ? path.relative(cwd, targetPath) || samePathFallback : targetPath;
}
