import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAgentTool } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";

export function listChannelAgentTools(params: {
  cfg?: ClawdbotConfig;
}): ChannelAgentTool[] {
  // Channel docking: aggregate channel-owned tools (login, etc.).
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) continue;
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) tools.push(...resolved);
  }
  return tools;
}
