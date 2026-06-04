import path from "node:path";

/**
 * POSIX path helpers for sandbox container paths.
 *
 * Container paths are always normalized as POSIX paths even when the host is not.
 */
/** Normalizes a container path and treats "." as the container root. */
export function normalizeContainerPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized === "." ? "/" : normalized;
}

/** Returns whether target is lexically inside root after container-path normalization. */
export function isPathInsideContainerRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedTarget = normalizeContainerPath(target);
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
