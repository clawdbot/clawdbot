// Embedded run entry helpers serialize runtime skill metadata for agent run records.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadSkillLibrarySelection } from "../library/selection.js";
import { resolveSkillRuntimeConfig } from "../loading/runtime-config.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { normalizeWorkspaceSkillRoots } from "../loading/workspace-skill-roots.js";
import {
  WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  type SkillEligibilityContext,
  type SkillEntry,
  type SkillSnapshot,
} from "../types.js";

/** Resolves skill entries embedded into a run payload into runtime-visible entries. */
export function resolveEmbeddedRunSkillEntries(params: {
  workspaceDir: string;
  executionWorkspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  skillsSnapshot?: SkillSnapshot;
  workspaceOnly?: boolean;
}): {
  shouldLoadSkillEntries: boolean;
  skillEntries: SkillEntry[];
  loadSkillEntries: () => SkillEntry[];
  preserveEntryOrder: boolean;
} {
  const shouldLoadSkillEntries =
    !params.skillsSnapshot ||
    (Boolean(params.skillsSnapshot.prompt.trim()) && !params.skillsSnapshot.resolvedSkills);
  const config = resolveSkillRuntimeConfig(params.config);
  // Materialized sandbox copies are the sole read root, including lazy rebuilds
  // of hydrated library snapshots that still carry their host provenance.
  const skillRoots = normalizeWorkspaceSkillRoots(
    params.workspaceOnly === true
      ? { agentWorkspaceDir: params.workspaceDir }
      : ((params.skillsSnapshot?.promptFormatVersion === WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
          ? params.skillsSnapshot.skillRoots
          : undefined) ?? {
          agentWorkspaceDir: params.workspaceDir,
          executionWorkspaceDir: params.executionWorkspaceDir,
        }),
  );
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
    cachedSkillEntries = loadWorkspaceSkills(skillRoots.agentWorkspaceDir, {
      ...options,
      executionWorkspaceDir: skillRoots.executionWorkspaceDir,
    });
    if (params.skillsSnapshot?.librarySelections?.length && params.workspaceOnly !== true) {
      cachedSkillEntries.push(
        ...loadSkillLibrarySelection(params.skillsSnapshot.librarySelections),
      );
    }
    return cachedSkillEntries;
  };
  return {
    shouldLoadSkillEntries,
    skillEntries: shouldLoadSkillEntries ? loadSkillEntries() : [],
    loadSkillEntries,
    // Merged loading orders agent skills first so prompt caps keep their priority.
    preserveEntryOrder: skillRoots.executionWorkspaceDir !== undefined,
  };
}
