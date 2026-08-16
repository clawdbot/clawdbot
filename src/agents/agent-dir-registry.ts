/** Process-local reverse registry from prepared agent directories to agent ids. */
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

// Process-local registry mapping resolved agent directories back to agent ids.
// It lets later runtime paths recover scope from an already-prepared agent dir.
const agentIdsByDir = new Map<string, Set<string>>();

export function normalizeAgentDirRegistryPath(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = path.resolve(resolveUserPath(agentDir, env));
  const missingSegments: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...missingSegments.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Register a resolved agent directory for later reverse lookup. */
export function registerResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const key = normalizeAgentDirRegistryPath(params.agentDir, params.env);
  const agentIds = agentIdsByDir.get(key) ?? new Set<string>();
  agentIds.add(normalizeAgentId(params.agentId));
  agentIdsByDir.set(key, agentIds);
}

/** Remove a reverse lookup only while it still belongs to the expected agent. */
export function unregisterResolvedAgentDir(params: {
  agentId: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const key = normalizeAgentDirRegistryPath(params.agentDir, params.env);
  const agentIds = agentIdsByDir.get(key);
  if (!agentIds?.delete(normalizeAgentId(params.agentId))) {
    return false;
  }
  if (agentIds.size === 0) {
    agentIdsByDir.delete(key);
  }
  return true;
}

/** Resolve the agent id previously registered for an agent directory. */
export function resolveRegisteredAgentIdForDir(
  agentDir: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const agentIds = agentIdsByDir.get(normalizeAgentDirRegistryPath(agentDir, env));
  return agentIds?.size === 1 ? agentIds.values().next().value : undefined;
}

/** Whether a path overlaps a directory currently owned by another agent. */
export function isPathOwnedByAnotherRegisteredAgent(params: {
  agentId: string;
  pathname: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const pathname = normalizeAgentDirRegistryPath(params.pathname, params.env);
  const agentId = normalizeAgentId(params.agentId);
  for (const [registeredDir, ownerIds] of agentIdsByDir) {
    if (
      [...ownerIds].some((ownerId) => ownerId !== agentId) &&
      (registeredDir === pathname ||
        isPathInside(registeredDir, pathname) ||
        isPathInside(pathname, registeredDir))
    ) {
      return true;
    }
  }
  return false;
}
