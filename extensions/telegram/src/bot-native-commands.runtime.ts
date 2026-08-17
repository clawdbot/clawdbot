import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Telegram plugin module implements bot native commands behavior.
import { resolveAgentScopedOutboundMediaAccess } from "openclaw/plugin-sdk/media-local-roots";

export {
  ensureConfiguredBindingRouteReady,
  recordInboundSessionMetaSafe,
} from "openclaw/plugin-sdk/conversation-runtime";
export { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
export { resolveAgentScopedOutboundMediaAccess };
export {
  finalizeInboundContext,
  resolveChunkMode,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
export { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
export { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

/**
 * Resolves policy-gated local media roots for a native command reply delivery.
 * Configured `agents.defaults.mediaLocalRoots` are honored only when the
 * sender/group host-media-read policy allows; the generic helper never grants
 * them as an ambient authorization.
 */
export function resolveNativeCommandOutboundMediaRoots(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string; accountId: string };
  auth: { isGroup: boolean; chatId: number; senderId?: string };
}): readonly string[] {
  return (
    resolveAgentScopedOutboundMediaAccess({
      cfg: params.cfg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      messageProvider: "telegram",
      accountId: params.route.accountId,
      groupId: params.auth.isGroup ? String(params.auth.chatId) : undefined,
      requesterSenderId: params.auth.senderId,
    }).localRoots ?? []
  );
}
