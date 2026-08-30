/**
 * Workspace directory normalization helpers. They expand user paths, reject
 * filesystem roots, and provide cwd fallback for runtime callers.
 */
import path from "node:path";
import { resolveUserPath } from "../utils.js";

/** Normalizes a workspace directory and rejects filesystem roots. */
export function normalizeWorkspaceDir(workspaceDir?: string): string | null {
  const trimmed = workspaceDir?.trim();
  if (!trimmed) {
    return null;
  }
  const expanded = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
  const resolved = path.resolve(expanded);
  // Refuse filesystem roots as "workspace" (too broad; almost always a bug).
  if (resolved === path.parse(resolved).root) {
    return null;
  }
  return resolved;
}

/** Resolves the effective workspace root, falling back to cwd. */
export function resolveWorkspaceRoot(workspaceDir?: string): string {
  return normalizeWorkspaceDir(workspaceDir) ?? process.cwd();
}
