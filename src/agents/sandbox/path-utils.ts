import path from "node:path";

export function normalizeContainerPath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized === "." ? "/" : normalized;
}

export function isPathInsideContainerRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedTarget = normalizeContainerPath(target);
  if (normalizedRoot === "/") {
    return true;
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

export function relativePathEscapesContainerRoot(relativePath: string): boolean {
  return (
    relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath)
  );
}
