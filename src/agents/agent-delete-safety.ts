/** Safety checks for deleting agents whose workspaces may overlap other agents. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db-registry.js";
import { listAgentEntries, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  type SharedAuthStoreOwnership,
} from "./auth-profiles/path-resolve.js";
import { resolveLegacyInheritedAuthAgentId } from "./legacy-inherited-auth-dir.js";
import { resolveCanonicalWorkspacePath } from "./workspace-state-identity.js";

/** True when deleting this agent database would remove the legacy shared auth store. */
export function isSharedAuthStoreOwner(params: {
  ownership: SharedAuthStoreOwnership;
  agentAuthDbPath: string;
  sharedAuthDbPath: string;
}): boolean {
  return (
    params.ownership.location === "legacy-main" &&
    isSameOpenClawAgentDatabasePath(params.agentAuthDbPath, params.sharedAuthDbPath)
  );
}

export function formatSharedAuthStoreOwnerDeleteError(agentId: string): string {
  return `Agent "${agentId}" owns the legacy shared auth store and cannot be deleted. Run openclaw doctor --fix to migrate shared auth, then retry.`;
}

export function isInheritedAuthStoreOwner(cfg: OpenClawConfig, agentId: string): boolean {
  // Relocation retires the implicit agent owner, but explicit bindings must be re-pointed.
  const explicitOwner = cfg.agents?.defaults?.authInheritance?.agentId?.trim();
  if (!explicitOwner && resolveSharedAuthStoreOwnership().location !== "legacy-main") {
    return false;
  }
  return agentId === normalizeAgentId(resolveLegacyInheritedAuthAgentId(cfg));
}
export function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = resolveCanonicalWorkspacePath(left.replaceAll("\0", ""));
  const normalizedRight = resolveCanonicalWorkspacePath(right.replaceAll("\0", ""));
  return (
    isPathInside(normalizedRight, normalizedLeft) || isPathInside(normalizedLeft, normalizedRight)
  );
}

/** Lists other agents whose workspaces overlap a candidate delete target. */
export function findOverlappingWorkspaceAgentIds(
  cfg: OpenClawConfig,
  agentId: string,
  workspaceDir: string,
): string[] {
  const entries = listAgentEntries(cfg);
  const normalizedAgentId = normalizeAgentId(agentId);
  const overlappingAgentIds: string[] = [];
  for (const entry of entries) {
    const otherAgentId = normalizeAgentId(entry.id);
    if (otherAgentId === normalizedAgentId) {
      continue;
    }
    const otherWorkspace = resolveAgentWorkspaceDir(cfg, otherAgentId);
    if (workspacePathsOverlap(workspaceDir, otherWorkspace)) {
      overlappingAgentIds.push(otherAgentId);
    }
  }
  return overlappingAgentIds;
}
