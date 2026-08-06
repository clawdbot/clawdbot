/** Last path segment for the folder trigger label; preserves filesystem roots. */
export function folderDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
