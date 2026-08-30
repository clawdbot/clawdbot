/**
 * Agent workspace directory collection.
 *
 * File sync and cleanup paths use this to enumerate configured agent workspaces
 * plus the default agent workspace without duplicating agent-scope logic.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import {
  listAgentEntries,
  resolveAgentWorkspaceDir,
  tryResolveSoleAgentId,
} from "./agent-scope-config.js";

/** Captures configured agent workspace ownership, including the implicit sole agent. */
export function resolveAgentWorkspaceDirsById(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, string> {
  const dirs = new Map<string, string>();
  for (const entry of listAgentEntries(cfg)) {
    dirs.set(normalizeAgentId(entry.id), resolveAgentWorkspaceDir(cfg, entry.id, env));
  }
  const soleAgentId = tryResolveSoleAgentId(cfg);
  if (soleAgentId) {
    dirs.set(normalizeAgentId(soleAgentId), resolveAgentWorkspaceDir(cfg, soleAgentId, env));
  }
  return dirs;
}

/** Lists unique workspace directories for configured agents and the default agent. */
export function listAgentWorkspaceDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...new Set(resolveAgentWorkspaceDirsById(cfg, env).values())];
}

/** Lists only entry-authored workspace paths without requiring a valid default marker. */
export function listExplicitAgentWorkspaceDirs(cfg: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  for (const entry of listAgentEntries(cfg)) {
    const workspace = typeof entry.workspace === "string" ? entry.workspace.trim() : "";
    if (workspace) {
      dirs.add(resolveUserPath(workspace));
    }
  }
  return [...dirs];
}
