/** Last path segment for the folder trigger label; preserves filesystem roots. */
export function folderDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? path;
}

export function parentFolderDisplayName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) {
    return undefined;
  }
  const parent = separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
  return folderDisplayName(parent) || undefined;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function comparableAbsolutePath(value: string): string | null {
  if (!isAbsolutePath(value)) {
    return null;
  }
  const path = value.trim().replaceAll("\\", "/");
  const windows = /^[A-Za-z]:\//u.test(path) || path.startsWith("//");
  const parts: string[] = [];
  const floor = /^[A-Za-z]:\//u.test(path) ? 1 : path.startsWith("//") ? 2 : 0;
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > floor) {
        parts.pop();
      }
      continue;
    }
    parts.push(part);
  }
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const normalized = `${prefix}${parts.join("/")}`.replace(/\/+$/u, "") || "/";
  return windows ? normalized.toLowerCase() : normalized;
}

/** Client-side affordance check; the Gateway remains the realpath authority. */
function isWorkspaceContainedPath(workspace: string, candidate: string): boolean {
  const root = comparableAbsolutePath(workspace);
  const target = comparableAbsolutePath(candidate);
  if (!root || !target) {
    return false;
  }
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

/** Checks a path against every configured or Gateway-approved workspace spelling. */
export function isKnownWorkspacePath(
  workspaceRoots: readonly string[],
  candidate: string,
): boolean {
  return workspaceRoots.some((root) => isWorkspaceContainedPath(root, candidate));
}
