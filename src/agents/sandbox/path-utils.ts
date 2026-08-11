/**
 * POSIX container path helpers for sandbox paths.
 *
 * Container paths normalize independently from host platform paths.
 */
import path from "node:path";

/** Normalizes a container path and treats "." as the container root. */
export function normalizeContainerPathCore(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized === "." ? "/" : normalized;
}

/** Returns whether target is lexically inside root after container-path normalization. */
export function isPathInsideContainerRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeContainerPathCore(root);
  const normalizedTarget = normalizeContainerPathCore(target);
  if (normalizedRoot === "/") {
    return true;
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

/** Returns whether a relative path would escape its container root. */
export function relativePathEscapesContainerRoot(relativePath: string): boolean {
  return (
    relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)
  );
}
