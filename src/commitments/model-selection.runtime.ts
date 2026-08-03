// Resolves model choices for commitment extraction and follow-up checks.
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";

// Lazy runtime seam for commitment extraction model selection. Keeps the
// background extraction runtime from loading model-selection code until needed.
export function resolveCommitmentDefaultModelRef(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): { provider: string; model: string } {
  return resolveDefaultModelForAgent(params);
}
