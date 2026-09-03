import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { loadSkillRootRecords, type LoadedSkillRecord } from "./skill-root-loader.js";

export function loadWorkshopSkills(params: {
  config?: OpenClawConfig;
  agentId?: string;
  workshopSkillsDir?: string;
  workspaceOnly: boolean;
}): LoadedSkillRecord[] {
  const workshopSkillsDir =
    params.workshopSkillsDir ??
    (params.config && params.agentId
      ? resolveWorkshopSkillsDir(params.config, params.agentId)
      : undefined);
  if (params.workspaceOnly || !workshopSkillsDir) {
    return [];
  }
  return loadSkillRootRecords({
    dir: workshopSkillsDir,
    source: "openclaw-workshop",
    config: params.config,
  });
}
