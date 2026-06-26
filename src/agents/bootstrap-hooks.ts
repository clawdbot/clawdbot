/**
 * Applies internal agent bootstrap hooks before workspace context is injected.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { triggerInternalHookWithScheduling } from "../hooks/internal-hook-dispatch.js";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { createInternalHookEvent } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

/** Runs bootstrap hooks and returns the effective bootstrap file list. */
export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const context: AgentBootstrapHookContext = {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: params.files,
    cfg: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId,
  };
  const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
  await triggerInternalHookWithScheduling(event, { yieldBetweenHandlers: true });
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  return Array.isArray(updated) ? updated : params.files;
}
