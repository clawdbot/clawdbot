import { resolveAgentEntry } from "../../agents/agent-scope-config.js";
// Agent skill filter helpers select skills that apply to a configured agent.
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeSkillFilter } from "./filter.js";

type AgentSkillsLimits = {
  maxSkillsPromptChars?: number;
};

/**
 * Explicit per-agent skills win when present; otherwise fall back to shared defaults.
 * Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
 */
export function resolveEffectiveAgentSkillFilter(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): string[] | undefined {
  if (!cfg) {
    return undefined;
  }
  const agentEntry = agentId ? resolveAgentEntry(cfg, agentId) : undefined;
  if (agentEntry && Object.hasOwn(agentEntry, "skills")) {
    return normalizeSkillFilter(agentEntry.skills);
  }
  return normalizeSkillFilter(cfg.agents?.defaults?.skills);
}

export function resolveEffectiveAgentSkillsLimits(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AgentSkillsLimits | undefined {
  if (!cfg || !agentId) {
    return undefined;
  }
  const agentEntry = resolveAgentEntry(cfg, agentId);
  if (!agentEntry || !Object.hasOwn(agentEntry, "skillsLimits")) {
    return undefined;
  }
  const { maxSkillsPromptChars } = agentEntry.skillsLimits ?? {};
  return typeof maxSkillsPromptChars === "number" ? { maxSkillsPromptChars } : undefined;
}
