import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isNotFoundPathError, isPathInside } from "../../infra/path-guards.js";

async function resolveRequestedRealPath(
  requestedPath: string,
  allowMissing: boolean,
): Promise<string | null> {
  try {
    return await fs.realpath(requestedPath);
  } catch (error) {
    if (!allowMissing || !isNotFoundPathError(error)) {
      return null;
    }
  }

  let ancestor = path.dirname(requestedPath);
  for (;;) {
    try {
      const ancestorRealPath = await fs.realpath(ancestor);
      return path.resolve(ancestorRealPath, path.relative(ancestor, requestedPath));
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        return null;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return null;
    }
    ancestor = parent;
  }
}

/** Resolves a Gateway path against the real roots of configured agent workspaces. */
export async function resolveWorkspacePathContainment(
  requestedPath: string | undefined,
  cfg: OpenClawConfig,
  options: { allowMissing?: boolean } = {},
): Promise<{ path: string; workspaceRoot: string } | null> {
  const workspaceRoots = await Promise.all(
    listAgentIds(cfg).map(async (agentId) => {
      try {
        return await fs.realpath(resolveAgentWorkspaceDir(cfg, agentId));
      } catch {
        return null;
      }
    }),
  );
  if (requestedPath === undefined) {
    const firstWorkspaceRoot = workspaceRoots[0];
    return firstWorkspaceRoot
      ? { path: firstWorkspaceRoot, workspaceRoot: firstWorkspaceRoot }
      : null;
  }
  const existingRoots = workspaceRoots.filter((root): root is string => root !== null);
  if (!path.isAbsolute(requestedPath)) {
    return null;
  }
  const requested = path.resolve(requestedPath);
  const requestedRealPath = await resolveRequestedRealPath(
    requested,
    options.allowMissing === true,
  );
  if (!requestedRealPath) {
    return null;
  }
  const workspaceRoot = existingRoots
    .filter((root) => isPathInside(root, requestedRealPath))
    .toSorted((left, right) => right.length - left.length)[0];
  return workspaceRoot ? { path: requestedRealPath, workspaceRoot } : null;
}
