import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Each agent owns the Workshop tree below its installation-managed agent directory. */
export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAgentDir(config, agentId, env), "workshop-skills");
}
