import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookSessionContext,
  PluginHookSessionEndEvent,
  PluginHookSessionEndReason,
} from "../plugins/hook-types.js";
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
} from "./internal-hooks.js";

export type InternalSessionEndRuntime = {
  config: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
  storePath?: string;
};

const INTERNAL_SESSION_END_REASONS = new Set<PluginHookSessionEndReason>([
  "new",
  "reset",
  "daily",
  "idle",
]);

export function isSessionRolloverEndReason(reason: unknown): reason is PluginHookSessionEndReason {
  return (
    typeof reason === "string" &&
    INTERNAL_SESSION_END_REASONS.has(reason as PluginHookSessionEndReason)
  );
}

export function hasInternalSessionEndListeners(): boolean {
  return hasInternalHookListeners("session", "end");
}

export async function triggerInternalSessionEnd(
  event: PluginHookSessionEndEvent,
  context: PluginHookSessionContext,
  runtime: InternalSessionEndRuntime,
): Promise<void> {
  if (!hasInternalSessionEndListeners() || !isSessionRolloverEndReason(event.reason)) {
    return;
  }

  const sessionKey = event.sessionKey ?? context.sessionKey;
  if (!sessionKey) {
    return;
  }
  const cfg = runtime.config;
  const marker = parseSqliteSessionFileMarker(event.sessionFile);
  const agentId =
    runtime.agentId ??
    context.agentId ??
    marker?.agentId ??
    resolveSessionAgentId({
      sessionKey,
      config: cfg,
    });
  const hookEvent = createInternalHookEvent("session", "end", sessionKey, {
    cfg,
    agentId,
    workspaceDir: runtime.workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId),
    storePath:
      runtime.storePath ?? marker?.storePath ?? resolveStorePath(cfg.session?.store, { agentId }),
    sessionEntry: {
      sessionId: event.sessionId,
      sessionFile: event.sessionFile,
    },
    reason: event.reason,
    messageCount: event.messageCount,
    durationMs: event.durationMs,
    transcriptArchived: event.transcriptArchived,
    nextSessionId: event.nextSessionId,
    nextSessionKey: event.nextSessionKey,
  });

  await triggerInternalHook(hookEvent);
}
