import type { ClawdbotConfig } from "../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: ClawdbotConfig;
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
  await triggerInternalHook(event);
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  return Array.isArray(updated) ? updated : params.files;
}
