/**
 * Shared workspace and sandbox path boundary helpers.
 *
 * Converts validated absolute or relative inputs into root-relative paths without allowing boundary escapes.
 */
import path from "node:path";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

// Shared path boundary helpers for workspace and sandbox-facing agent inputs.
// Callers get normalized relative paths only after the candidate proves it stays
// within the named root.
type RelativePathOptions = {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
};

function throwPathEscapesBoundary(params: {
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): never {
  const boundary = params.options?.boundaryLabel ?? "workspace root";
  const suffix = params.options?.includeRootInError ? ` (${params.rootResolved})` : "";
  throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
}

function validateRelativePathWithinBoundary(params: {
  relativePath: string;
  isAbsolutePath: (path: string) => boolean;
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): string {
  // path.relative returns "." for the root itself. Treat that as escaping unless
  // the caller explicitly accepts root-targeting operations.
  if (params.relativePath === "" || params.relativePath === ".") {
    if (params.options?.allowRoot) {
      return "";
    }
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved: params.rootResolved,
      candidate: params.candidate,
    });
  }
  // The absolute-path check catches Windows drive-relative oddities after
  // normalization, while the prefix checks cover ordinary parent traversal.
  if (
    params.relativePath === ".." ||
    params.relativePath.startsWith("../") ||
    params.relativePath.startsWith("..\\") ||
    params.isAbsolutePath(params.relativePath)
  ) {
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved: params.rootResolved,
      candidate: params.candidate,
    });
  }
  return params.relativePath;
}

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  const resolvedInput = resolveSandboxInputPath(
    params.candidate,
    params.options?.cwd ?? params.root,
  );

  if (process.platform === "win32") {
    // Windows comparisons need normalized separators and drive casing before
    // path.relative; otherwise the same root can look outside the boundary.
    const rootResolved = path.win32.resolve(params.root);
    const resolvedCandidate = path.win32.resolve(resolvedInput);
    const rootForCompare = normalizeWindowsPathForComparison(rootResolved);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedCandidate);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    return validateRelativePathWithinBoundary({
      relativePath: relative,
      isAbsolutePath: path.win32.isAbsolute,
      options: params.options,
      rootResolved,
      candidate: params.candidate,
    });
  }

  const rootResolved = path.resolve(params.root);
  const resolvedCandidate = path.resolve(resolvedInput);
  const relative = path.relative(rootResolved, resolvedCandidate);
  return validateRelativePathWithinBoundary({
    relativePath: relative,
    isAbsolutePath: path.isAbsolute,
    options: params.options,
    rootResolved,
    candidate: params.candidate,
  });
}

function toRelativeBoundaryPath(params: {
  root: string;
  candidate: string;
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">;
  boundaryLabel: string;
  includeRootInError?: boolean;
}): string {
  return toRelativePathUnderRoot({
    root: params.root,
    candidate: params.candidate,
    options: {
      allowRoot: params.options?.allowRoot,
      cwd: params.options?.cwd,
      boundaryLabel: params.boundaryLabel,
      includeRootInError: params.includeRootInError,
    },
  });
}

/**
 * Return a workspace-relative path for a candidate path after rejecting paths
 * that escape the workspace root.
 */
export function toRelativeWorkspacePath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    root,
    candidate,
    options,
    boundaryLabel: "workspace root",
  });
}

/**
 * Return a sandbox-relative path for a candidate path after rejecting paths that
 * escape the sandbox root. Errors include the sandbox root for operator clarity.
 */
export function toRelativeSandboxPath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativeBoundaryPath({
    root,
    candidate,
    options,
    boundaryLabel: "sandbox root",
    includeRootInError: true,
  });
}

/** Resolve a user-supplied path against `cwd` using the sandbox input rules. */
export function resolvePathFromInput(filePath: string, cwd: string): string {
  return path.normalize(resolveSandboxInputPath(filePath, cwd));
}
