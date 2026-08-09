import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import type { PluginHookSessionEndReason } from "../plugins/hook-types.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "./internal-hooks.js";

type SessionAutoResetReason = Extract<PluginHookSessionEndReason, "daily" | "idle">;

export function isSessionAutoResetReason(reason: unknown): reason is SessionAutoResetReason {
  return reason === "daily" || reason === "idle";
}

export function hasSessionAutoResetListeners(): boolean {
  return hasInternalHookListeners("session", "auto-reset");
}

export function emitSessionAutoResetHook(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  reason: PluginHookSessionEndReason | undefined;
  sessionFile?: string;
  transcriptArchived?: boolean;
  nextSessionId?: string;
  nextSessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  storePath?: string;
}): void {
  if (!isSessionAutoResetReason(params.reason) || !hasSessionAutoResetListeners()) {
    return;
  }

  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  const agentId =
    params.agentId ??
    marker?.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const event = createInternalHookEvent("session", "auto-reset", params.sessionKey, {
    cfg: params.cfg,
    agentId,
    workspaceDir: params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId),
    storePath:
      params.storePath ??
      marker?.storePath ??
      resolveStorePath(params.cfg.session?.store, { agentId }),
    sessionEntry: {
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
    },
    reason: params.reason,
    transcriptArchived: params.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  });

  void runWithGatewayIndependentRootWorkContinuation(() => triggerInternalHook(event)).catch(
    (error: unknown) => {
      logVerbose(`session:auto-reset hook failed: ${String(error)}`);
    },
  );
}
