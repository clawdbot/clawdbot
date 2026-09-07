import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type DoctorWorkspaceSuggestionScope = {
  agentId: string;
  workspaceDir: string;
  labelAgent: boolean;
};

/** Resolves every configured agent workspace while preserving invalid empty-roster failures. */
export function resolveDoctorWorkspaceSuggestionScopes(
  cfg: OpenClawConfig,
): DoctorWorkspaceSuggestionScope[] {
  const listedAgentIds = listAgentIds(cfg);
  const agentIds = listedAgentIds.length > 0 ? listedAgentIds : [resolveDefaultAgentId(cfg)];
  const labelAgent = agentIds.length > 1;
  return agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    labelAgent,
  }));
}
