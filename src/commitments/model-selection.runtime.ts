import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";

export function resolveCommitmentDefaultModelRef(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): { provider: string; model: string } {
  return resolveDefaultModelForAgent(params);
}
