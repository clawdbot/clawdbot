import {
  resolveAgentOperationAgentId,
  resolveConfiguredAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Validate the selected operation owner before using its workspace for discovery. */
export function resolveChannelSetupOwner(cfg: OpenClawConfig, requestedAgentId?: string) {
  const requested = requestedAgentId?.trim();
  if (requestedAgentId !== undefined && !requested) {
    throw new Error("--agent must not be blank");
  }
  // Explicit CLI IDs must match the roster rather than normalize into a different agent.
  const agentId = resolveConfiguredAgentId(
    cfg,
    requested ??
      resolveAgentOperationAgentId(cfg, undefined, {
        surface: "channel plugin discovery",
        hint: "Pass --agent <id> to channels commands or set agents.defaults.systemAgent.agentId.",
      }),
  );
  return { agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) };
}
