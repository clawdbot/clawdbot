import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAgentDir(config, agentId, env), "workshop-skills");
}

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
