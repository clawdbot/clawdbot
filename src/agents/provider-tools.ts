import type { ClawdbotConfig } from "../config/config.js";
import { listProviderPlugins } from "../providers/plugins/index.js";
import type { ProviderAgentTool } from "../providers/plugins/types.js";

export function listProviderAgentTools(params: {
  cfg?: ClawdbotConfig;
}): ProviderAgentTool[] {
  // Provider docking: aggregate provider-owned tools (login, etc.).
  const tools: ProviderAgentTool[] = [];
  for (const plugin of listProviderPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) continue;
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) tools.push(...resolved);
  }
  return tools;
}
