// Embedded run entry helpers serialize runtime skill metadata for agent run records.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";

/** Resolves skill entries embedded into a run payload into runtime-visible entries. */
export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  skillsSnapshot?: SkillSnapshot;
  workspaceOnly?: boolean;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
  loadSkillEntries: () => SkillEntry[];
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);
  let cachedSkillEntries: SkillEntry[] | undefined;
  const loadSkillEntries = (): SkillEntry[] => {
    if (cachedSkillEntries) {
      return cachedSkillEntries;
    }
    cachedSkillEntries = loadWorkspaceSkills(params.workspaceDir, {
      config,
      agentId: params.agentId,
      ...(params.eligibility ? { eligibility: params.eligibility } : {}),
      ...(params.workspaceOnly === true ? { workspaceOnly: true } : {}),
    });
    return cachedSkillEntries;
  };
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries ? loadSkillEntries() : [],
    loadSkillEntries,
  };
}
