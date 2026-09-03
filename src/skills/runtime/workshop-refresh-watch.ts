import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";

export function resolveWorkshopWatchRoots(config?: OpenClawConfig, agentId?: string) {
  return config && agentId
    ? [{ path: resolveWorkshopSkillsDir(config, agentId), source: "openclaw-workshop" }]
    : [];
}

export function createWorkshopWatcherKey(
  workspaceDir: string,
  params: { executionSkillsDir?: string; agentId?: string },
): string {
  return JSON.stringify([workspaceDir, params.executionSkillsDir, params.agentId]);
}
