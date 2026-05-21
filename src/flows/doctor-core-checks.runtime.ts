import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}
