// Embedded run entry helpers serialize runtime skill metadata for agent run records.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";
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
} {
  const shouldLoadSkillEntries = !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
  const config = resolveSkillRuntimeConfig(params.config);
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries
      ? loadWorkspaceSkillEntries(params.workspaceDir, {
          config,
          agentId: params.agentId,
          ...(params.eligibility ? { eligibility: params.eligibility } : {}),
          ...(params.workspaceOnly === true ? { workspaceOnly: true } : {}),
        })
      : [],
  };
}
