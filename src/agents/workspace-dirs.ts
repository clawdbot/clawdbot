/**
 * Agent workspace directory collection.
 *
 * File sync and cleanup paths use this to enumerate configured agent workspaces
 * plus the default agent workspace without duplicating agent-scope logic.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";

/** Lists unique workspace directories for configured agents and the default agent. */
export function listAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        dirs.add(resolveAgentWorkspaceDir(cfg, entry.id));
      }
    }
  }
  dirs.add(resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  return [...dirs];
}
