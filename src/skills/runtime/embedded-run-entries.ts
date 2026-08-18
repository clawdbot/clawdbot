// Embedded run entry helpers serialize runtime skill metadata for agent run records.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import {
  loadMergedWorkspaceSkills,
  loadWorkspaceSkills,
  normalizeWorkspaceSkillRoots,
} from "../loading/workspace-skill-loader.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";

/** Resolves skill entries embedded into a run payload into runtime-visible entries. */
export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  executionSkillsDir?: string;
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
    const options = {
      config,
      agentId: params.agentId,
      ...(params.eligibility ? { eligibility: params.eligibility } : {}),
      ...(params.skillsSnapshot?.skillFilter
        ? { skillFilter: params.skillsSnapshot.skillFilter }
        : {}),
      ...(params.skillsSnapshot?.skillOverrides
        ? { skillOverrides: params.skillsSnapshot.skillOverrides }
        : {}),
      ...(params.workspaceOnly === true ? { workspaceOnly: true } : {}),
    };
    const liveSkillRoots = normalizeWorkspaceSkillRoots({
      agentWorkspaceDir: params.workspaceDir,
      ...(params.executionSkillsDir ? { executionSkillsDir: params.executionSkillsDir } : {}),
    });
    const skillRoots = params.skillsSnapshot?.skillRoots ?? liveSkillRoots;
    cachedSkillEntries = skillRoots.executionSkillsDir
      ? loadMergedWorkspaceSkills({ ...skillRoots, ...options })
      : loadWorkspaceSkills(params.workspaceDir, options);
    return cachedSkillEntries;
  };
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries ? loadSkillEntries() : [],
    loadSkillEntries,
  };
}
