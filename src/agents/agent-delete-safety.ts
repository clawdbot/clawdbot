/** Safety checks for deleting agents whose workspaces may overlap other agents. */
import fs from "node:fs";
import path from "node:path";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveAgentWorkspaceDir } from "./agent-scope.js";

function normalizeWorkspacePathForComparison(input: string): string {
  const resolved = path.resolve(input.replaceAll("\0", ""));
  let normalized = resolved;
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return lowercasePreservingWhitespace(normalized);
  }
  return normalized;
}

function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePathForComparison(left);
  const normalizedRight = normalizeWorkspacePathForComparison(right);
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
