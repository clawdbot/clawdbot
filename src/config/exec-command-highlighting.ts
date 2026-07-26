import { resolveAgentConfig } from "../agents/agent-scope-config.js";
// Resolves exec command highlighting config for agent sessions.
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves whether exec command highlighting is enabled for the current agent scope. */
export function resolveExecCommandHighlighting(params: {
  config?: OpenClawConfig | null;
  agentId?: string | null;
}): boolean {
  const config = params.config ?? {};
  const globalValue = config.tools?.exec?.commandHighlighting;
  const agentId = params.agentId ? normalizeAgentId(params.agentId) : null;
  const agentValue = agentId
    ? resolveAgentConfig(config, agentId)?.tools?.exec?.commandHighlighting
    : undefined;
  // Agent-scoped config overrides the global exec setting; absent config stays disabled.
  return agentValue ?? globalValue ?? false;
}
